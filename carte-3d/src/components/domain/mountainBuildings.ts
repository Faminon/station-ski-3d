// Petits bâtiments et équipements 3D des lieux du domaine (carte des 3 Vallées) :
// chalets des restaurants et refuges, cabanons de toilettes, postes de secours,
// tables de pique-nique, belvédères, modules de snowpark… en « fill-extrusion »
// posés sur le relief. Les lieux des villages dont AltiStay a les bâtiments
// réels (vue 3D des stations) n'en ont pas besoin et sont écartés.
//
// Comme pour les remontées, les volumes grossissent en dézoomant pour rester
// visibles, et ne sont recalculés qu'aux changements de palier de zoom.
// Chaque volume porte la catégorie de son lieu : le calque suit les catégories
// cochées dans le panneau (filtre sur `cat`).

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FeatureCollection, Polygon } from 'geojson';
import type { DomainPoi, DomainPoiCategoryId } from '@/lib/domainPois';
import { METERS_PER_DEG_LAT, metersPerDegLng } from '@/lib/apis/overpass';

export const BUILDINGS_LAYER = 'place-buildings';
const MIN_ZOOM = 13;
const REF_ZOOM = 15.5;
const MAX_SCALE = 4;

/** Zone couverte par les bâtiments réels d'une station (cercle autour d'un village). */
export interface BuiltArea {
  lat: number;
  lng: number;
  radius: number;
}

const WOOD = ['#8a5a36', '#9b6a40', '#7a4e2e', '#a8774b'];
const DARK_WOOD = '#6b4426';
const STONE = '#9a958c';
const RENDER = ['#efe6d6', '#e8dcc6', '#f3ede2'];
const WHITE = '#f8f9fa';
const SNOW = '#f8fbfe';
const SNOW_SHADE = '#e3ecf5';
const STEEL = '#5c636a';
const RED = '#e03131';
const GREEN = '#2f9e44';
const BLUE = '#1971c2';
const ORANGE = '#f08c00';

/** Catégories qui ont un modèle 3D ; les autres (cols, lacs, parkings…) restent de simples pastilles. */
const MODELED = new Set<DomainPoiCategoryId>([
  // Les snowparks n'ont pas de modèle ici : leurs modules couvrent toute la descente (parkFeatures.ts).
  'restaurant', 'hut', 'bar', 'lodging', 'toilets', 'rescue', 'picnic', 'viewpoint', 'info',
  'ski', 'shop', 'grocery', 'services', 'leisure',
]);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** Lieux à modéliser, hors des villages déjà bâtis en 3D. */
export function mountainPlaces(pois: DomainPoi[], built: BuiltArea[]): DomainPoi[] {
  return pois.filter((p) => {
    if (!MODELED.has(p.category)) return false;
    const mx = metersPerDegLng(p.lat);
    return !built.some((a) => Math.hypot((p.lat - a.lat) * METERS_PER_DEG_LAT, (p.lng - a.lng) * mx) < a.radius);
  });
}

/** Volume posé sur le relief : contour, couleur `c`, bas `b` et haut `h` (m) au-dessus du sol sous son centre. */
export type PlaceVolume = FeatureCollection<Polygon, { c: string; b: number; h: number; cat: string }>['features'][number];
type Volume = PlaceVolume;

/**
 * Outil de construction autour d'un lieu, dans un repère tourné au hasard
 * (stable d'un affichage à l'autre) : `box(longueur, largeur, bas, haut,
 * couleur, décalage en long, décalage en large)`, demi-dimensions en mètres.
 */
function builder(out: Volume[], p: DomainPoi) {
  const seed = hash(p.id);
  const angle = seed * Math.PI;
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const mx = metersPerDegLng(p.lat);
  const box = (along: number, across: number, b: number, h: number, c: string, dx = 0, dy = 0) => {
    // (uy, -ux) : vers la droite du grand axe.
    const corner = (sa: number, sr: number) => {
      const a = dx + along * sa;
      const r = dy + across * sr;
      return [p.lng + (ux * a + uy * r) / mx, p.lat + (uy * a - ux * r) / METERS_PER_DEG_LAT];
    };
    const ring = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
    ring.push(ring[0]);
    out.push({ type: 'Feature', properties: { c, b, h, cat: p.category }, geometry: { type: 'Polygon', coordinates: [ring] } });
  };
  /** Polygone quelconque, points en [long, large] (mètres) dans le repère du lieu. */
  const poly = (points: [number, number][], b: number, h: number, c: string) => {
    const ring = points.map(([a, r]) => [p.lng + (ux * a + uy * r) / mx, p.lat + (uy * a - ux * r) / METERS_PER_DEG_LAT]);
    ring.push(ring[0]);
    out.push({ type: 'Feature', properties: { c, b, h, cat: p.category }, geometry: { type: 'Polygon', coordinates: [ring] } });
  };
  return { box, poly, seed };
}

type Poly = ReturnType<typeof builder>['poly'];

type Box = ReturnType<typeof builder>['box'];

/** Toit à deux pans enneigé, en gradins de plus en plus étroits, débordant des murs. */
function snowRoof(box: Box, L: number, W: number, from: number, k: number, kv: number, steps = 4) {
  for (let i = 0; i < steps; i++) {
    box(L + 1.2 * k, (W + 1.5 * k) * (1 - i / steps), from + i * 0.9 * kv, from + (i + 1) * 0.9 * kv, i % 2 ? SNOW_SHADE : SNOW);
  }
}

/** Chalet en bois sur soubassement de pierre (restaurants, refuges, bars). */
function chalet(box: Box, seed: number, k: number, kv: number, size = 1) {
  const L = (11 + seed * 5) * k * size;
  const W = 7.5 * k * size;
  const wall = 5.5 * kv;
  box(L, W, 0, 1.2 * kv, STONE);
  box(L, W, 1.2 * kv, wall, WOOD[Math.floor(seed * WOOD.length)]);
  snowRoof(box, L, W, wall, k, kv);
}

const RESTAURANT_ORANGE = '#e8590c';
const GLASS = '#35556f';
const SILVER = '#d5dae0';
const SILVER_SHADE = '#aab2bb';
const PLATE = '#fbfbf8';
const DECK = '#b07a4a';
const PARASOLS = [RESTAURANT_ORANGE, '#ffffff', '#c92a2a'];

/**
 * Enseigne géante dressée sur le faîte du toit : fourchette, assiette et couteau, dans le plan
 * vertical du faîte (visibles depuis les deux grands côtés). `z0` : haut du toit.
 */
function cutlerySign(box: Box, scale: number, z0: number) {
  // Enseigne plus grande que nature : lisible de loin, comme sur un plan des pistes illustré.
  const k = scale * 1.5;
  const T = 0.22 * k; // demi-épaisseur des pièces
  // Pièce verticale du plan de l'enseigne : de a0 à a1 le long du faîte, de z1 à z2 en hauteur.
  const slab = (a0: number, a1: number, z1: number, z2: number, c: string, thick = T, dy = 0) =>
    box((a1 - a0) / 2, thick, z1, z2, c, (a0 + a1) / 2, dy);

  // Assiette : disque vertical en tranches, bord orange et fond blanc en léger relief.
  const r = 3.2 * k;
  const cz = z0 + 1.2 * k + r;
  const slices = 12;
  for (let j = 0; j < slices; j++) {
    const y0 = -r + (2 * r * j) / slices;
    const y1 = y0 + (2 * r) / slices;
    const ym = (y0 + y1) / 2;
    const hw = Math.sqrt(Math.max(0, r * r - ym * ym));
    slab(-hw, hw, cz + y0, cz + y1, RESTAURANT_ORANGE);
    const ri = 0.74 * r;
    if (Math.abs(ym) < ri) {
      const hi = Math.sqrt(ri * ri - ym * ym);
      slab(-hi, hi, cz + y0, cz + y1, PLATE, T * 1.6);
    }
  }
  // Pied de l'assiette.
  slab(-0.3 * k, 0.3 * k, z0, cz - r + 0.2 * k, SILVER_SHADE);

  // Fourchette, à gauche : manche, collet, quatre dents.
  const fa = -(r + 2.4 * k);
  slab(fa - 0.32 * k, fa + 0.32 * k, z0, z0 + 3.4 * k, SILVER_SHADE);
  slab(fa - 1.05 * k, fa + 1.05 * k, z0 + 3.4 * k, z0 + 4.1 * k, SILVER);
  for (const t of [-0.82, -0.28, 0.28, 0.82]) slab(fa + (t - 0.16) * k, fa + (t + 0.16) * k, z0 + 4.1 * k, z0 + 7 * k, SILVER);

  // Couteau, à droite : manche sombre, mitre, lame au bout arrondi d'un côté.
  const ka = r + 2.4 * k;
  slab(ka - 0.36 * k, ka + 0.36 * k, z0, z0 + 3 * k, '#495057');
  slab(ka - 0.5 * k, ka + 0.5 * k, z0 + 3 * k, z0 + 3.35 * k, SILVER_SHADE);
  const blade = 3.9 * k;
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const z1 = z0 + 3.35 * k + (blade * i) / steps;
    const z2 = z1 + blade / steps;
    // Dos droit côté gauche, tranchant qui s'arrondit vers la pointe.
    const t = (i + 0.5) / steps;
    const width = 1.2 * k * Math.sqrt(Math.max(0.08, 1 - Math.max(0, (t - 0.45) / 0.55) ** 2));
    slab(ka - 0.6 * k, ka - 0.6 * k + width, z1, z2, SILVER);
  }
}

/** Parasol de terrasse : mât, toile octogonale en deux étages (effet de cône). */
function parasol(box: Box, poly: Poly, k: number, kv: number, a: number, r: number, base: number, color: string) {
  box(0.1 * k, 0.1 * k, base, base + 3.2 * kv, '#495057', a, r);
  const ring = (radius: number) =>
    Array.from({ length: 8 }, (_, i) => {
      const t = (i / 8) * Math.PI * 2 + Math.PI / 8;
      return [a + Math.cos(t) * radius, r + Math.sin(t) * radius] as [number, number];
    });
  poly(ring(1.9 * k), base + 2.6 * kv, base + 2.85 * kv, color);
  poly(ring(1.1 * k), base + 2.85 * kv, base + 3.15 * kv, color);
  poly(ring(0.35 * k), base + 3.15 * kv, base + 3.35 * kv, color);
}

/**
 * Restaurant d'altitude : chalet aux grandes baies vitrées, bandeau orange, enseigne géante
 * (couverts et assiette) sur le toit, terrasse en bois avec tables, chaises et parasols.
 */
function restaurant(box: Box, poly: Poly, seed: number, k: number, kv: number) {
  const L = (12 + seed * 4) * k;
  const W = 8 * k;
  const wall = 6 * kv;
  box(L, W, 0, 1.2 * kv, STONE);
  box(L, W, 1.2 * kv, wall, WOOD[Math.floor(seed * WOOD.length)]);
  // Baies vitrées sur les deux grands côtés, et bandeau orange sous le toit.
  box(L * 0.82, W + 0.12 * k, 1.8 * kv, 4.4 * kv, GLASS);
  box(L + 0.15 * k, W + 0.15 * k, wall - 1 * kv, wall - 0.35 * kv, RESTAURANT_ORANGE);
  snowRoof(box, L, W, wall, k, kv);
  const roofTop = wall + 4 * 0.9 * kv;
  // Cheminée de pierre qui fume… en tout cas qui dépasse.
  box(0.8 * k, 0.8 * k, wall, roofTop + 1.4 * kv, STONE, L * 0.62, -W * 0.25);
  cutlerySign(box, k, roofTop - 0.6 * kv);

  // Terrasse en bois devant le grand côté sud du chalet (côté +large), surélevée.
  const deckW = 4.2 * k;
  const deckR = W + deckW;
  const deckTop = 0.9 * kv;
  box(L * 0.92, deckW, 0, deckTop, DECK, 0, deckR);
  // Garde-corps : lisse sur le bord extérieur et les deux bouts.
  box(L * 0.92, 0.1 * k, deckTop, deckTop + 1 * kv, DARK_WOOD, 0, deckR + deckW);
  for (const end of [-1, 1]) box(0.1 * k, deckW, deckTop, deckTop + 1 * kv, DARK_WOOD, end * L * 0.92, deckR);
  // Tables, chaises et parasols, en rang le long de la terrasse.
  const tables = Math.max(3, Math.round((L / k) / 5));
  for (let i = 0; i < tables; i++) {
    const a = -L * 0.75 + (i * (L * 1.5)) / (tables - 1);
    const r = deckR + 0.6 * k;
    box(0.55 * k, 0.55 * k, deckTop, deckTop + 0.8 * kv, WOOD[3], a, r);
    for (const side of [-1, 1]) box(0.3 * k, 0.3 * k, deckTop, deckTop + 0.5 * kv, DARK_WOOD, a + side * 1 * k, r);
    parasol(box, poly, k, kv, a, r, deckTop, PARASOLS[i % PARASOLS.length]);
  }
  // Transats sur la neige, au bord de la terrasse.
  for (let i = 0; i < 3; i++) {
    const a = -L * 0.4 + i * 1.6 * k;
    box(0.45 * k, 1 * k, 0, 0.35 * kv, i % 2 ? RESTAURANT_ORANGE : '#1971c2', a, deckR + deckW + 2.4 * k);
    box(0.45 * k, 0.25 * k, 0.35 * kv, 0.9 * kv, i % 2 ? RESTAURANT_ORANGE : '#1971c2', a, deckR + deckW + 1.5 * k);
  }
}

const HUT_STONE = '#a39d92';
const HUT_STONE_DARK = '#7d786f';
const SHUTTER = '#2b8a3e';
const HUT_SIGN = '#7a4e2e';

/**
 * Panneau « refuge » géant sur le faîte : planche de bois et pictogramme de cabane blanc
 * (toit en gradins, murs, porte), dans le plan vertical du faîte. `z0` : haut du toit.
 */
function hutSign(box: Box, scale: number, z0: number) {
  const s = scale * 1.3;
  const fig = 0.22 * s;
  box(0.18 * s, 0.18 * s, z0, z0 + 0.8 * s, '#495057');
  box(2.7 * s, 0.12 * s, z0 + 0.8 * s, z0 + 5.4 * s, HUT_SIGN);
  box(2.9 * s, 0.12 * s, z0 + 1 * s, z0 + 5.2 * s, HUT_SIGN);
  // Murs de la cabane et porte (en creux, couleur du panneau).
  box(1.3 * s, fig, z0 + 1.4 * s, z0 + 3.1 * s, WHITE);
  box(0.38 * s, fig * 1.15, z0 + 1.4 * s, z0 + 2.5 * s, HUT_SIGN);
  // Toit en gradins de plus en plus étroits, débordant des murs.
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    const z1 = z0 + 3.1 * s + (i * 1.7 * s) / steps;
    box((1.85 - (1.7 * i) / steps) * s, fig, z1, z1 + (1.7 * s) / steps, WHITE);
  }
}

/**
 * Refuge de montagne : murs de pierre, petites fenêtres aux volets verts, porte en bois,
 * toit enneigé avec cheminée, panneau géant sur le faîte, drapeau tricolore, tas de bois et banc.
 */
function refuge(box: Box, seed: number, k: number, kv: number) {
  const L = (7 + seed * 2) * k;
  const W = 5.5 * k;
  const wall = 4.6 * kv;
  box(L + 0.15 * k, W + 0.15 * k, 0, 0.8 * kv, HUT_STONE_DARK);
  box(L, W, 0.8 * kv, wall, HUT_STONE);
  // Fenêtres à volets verts sur les deux grands côtés.
  for (const a of [-L * 0.55, 0, L * 0.55]) {
    box(0.45 * k, W + 0.06 * k, 1.9 * kv, 3.1 * kv, GLASS, a);
    for (const side of [-1, 1]) box(0.25 * k, W + 0.12 * k, 1.9 * kv, 3.1 * kv, SHUTTER, a + side * 0.72 * k);
  }
  // Porte en bois sur le pignon, et banc le long de la façade.
  box(L + 0.12 * k, 0.75 * k, 0.8 * kv, 3 * kv, DARK_WOOD);
  box(L * 0.6, 0.35 * k, 0, 0.5 * kv, WOOD[3], 0, W + 0.9 * k);
  snowRoof(box, L, W, wall, k, kv, 3);
  const roofTop = wall + 3 * 0.9 * kv;
  box(0.7 * k, 0.7 * k, wall, roofTop + 1.3 * kv, HUT_STONE_DARK, -L * 0.6, W * 0.3);
  hutSign(box, k, roofTop - 0.5 * kv);

  // Drapeau tricolore au bout du refuge.
  const fa = L + 2.6 * k;
  box(0.1 * k, 0.1 * k, 0, 8.5 * kv, STEEL, fa);
  const flag = [BLUE, WHITE, RED];
  flag.forEach((c, i) => box(0.06 * k, 0.45 * k, 7 * kv, 8.3 * kv, c, fa, 0.55 * k + i * 0.9 * k));

  // Tas de bûches sous un peu de neige, à l'autre bout.
  const wa = -L - 1.6 * k;
  box(0.7 * k, 1.6 * k, 0, 1.1 * kv, WOOD[2], wa);
  box(0.75 * k, 1.65 * k, 1.1 * kv, 1.3 * kv, SNOW, wa);
}

/** Bâtiment crépi de plusieurs étages (hôtels, résidences). */
function lodge(box: Box, seed: number, k: number, kv: number) {
  const L = (14 + seed * 6) * k;
  const W = 9 * k;
  const floors = 2 + Math.floor(seed * 3);
  box(L, W, 0, 1.2 * kv, STONE);
  box(L, W, 1.2 * kv, 1.2 * kv + floors * 3 * kv, RENDER[Math.floor(seed * RENDER.length)]);
  // Balcons en bois sur la façade.
  for (let f = 1; f <= floors; f++) box(L * 0.95, W + 0.8 * k, (1.2 + f * 3 - 0.5) * kv, (1.2 + f * 3 - 0.2) * kv, DARK_WOOD);
  snowRoof(box, L, W, 1.2 * kv + floors * 3 * kv, k, kv);
}

/** Petit bâtiment de village, avec un bandeau de couleur (enseigne) sous le toit. */
function shop(box: Box, seed: number, k: number, kv: number, band: string) {
  const L = (7 + seed * 3) * k;
  const W = 5.5 * k;
  const wall = 4.5 * kv;
  box(L, W, 0, wall, RENDER[Math.floor(seed * RENDER.length)]);
  box(L + 0.2 * k, W + 0.2 * k, wall - 1 * kv, wall - 0.3 * kv, band);
  snowRoof(box, L, W, wall, k, kv, 3);
}

/** Cabanon de toilettes (ou fontaine pour un point d'eau). */
function toilets(box: Box, k: number, kv: number, water: boolean) {
  if (water) {
    // Fontaine : bassin de pierre et borne bleue.
    box(1.6 * k, 0.9 * k, 0, 0.7 * kv, STONE);
    box(0.35 * k, 0.35 * k, 0, 1.6 * kv, BLUE, -1.1 * k);
    return;
  }
  toiletBlock(box, k, kv);
}

const WC_PINK = '#d6336c';
const WC_WHITE = '#ffffff';

/** Disque vertical (dans le plan du faîte) en tranches : têtes des pictogrammes. */
function verticalDisc(box: Box, a: number, cz: number, r: number, thick: number, c: string, slices = 6) {
  for (let j = 0; j < slices; j++) {
    const y0 = -r + (2 * r * j) / slices;
    const y1 = y0 + (2 * r) / slices;
    const ym = (y0 + y1) / 2;
    const hw = Math.sqrt(Math.max(0, r * r - ym * ym));
    box(hw, thick, cz + y0, cz + y1, c, a);
  }
}

/**
 * Panneau « toilettes » géant sur le faîte : pictogrammes homme et femme blancs sur fond bleu,
 * dans le plan vertical du faîte (visibles des deux grands côtés). `z0` : haut du toit.
 */
function toiletSign(box: Box, scale: number, z0: number) {
  const s = scale * 1.3;
  const panel = 0.12 * s;
  const fig = 0.24 * s; // les pictogrammes dépassent du panneau des deux côtés
  // Mât et panneau bleu aux coins arrondis (deux rectangles croisés).
  box(0.18 * s, 0.18 * s, z0, z0 + 0.8 * s, '#495057');
  box(3.3 * s, panel, z0 + 0.8 * s, z0 + 5.6 * s, BLUE);
  box(3.5 * s, panel, z0 + 1 * s, z0 + 5.4 * s, BLUE);
  // Séparation blanche au milieu.
  box(0.07 * s, fig, z0 + 1.3 * s, z0 + 5.1 * s, WC_WHITE);

  // Homme, à gauche : tête, buste et bras, deux jambes.
  const m = -1.7 * s;
  verticalDisc(box, m, z0 + 4.45 * s, 0.42 * s, fig, WC_WHITE);
  box(0.62 * s, fig, z0 + 2.75 * s, z0 + 3.85 * s, WC_WHITE, m);
  for (const side of [-1, 1]) {
    box(0.13 * s, fig, z0 + 2.75 * s, z0 + 3.75 * s, WC_WHITE, m + side * 0.82 * s);
    box(0.24 * s, fig, z0 + 1.3 * s, z0 + 2.75 * s, WC_WHITE, m + side * 0.3 * s);
  }

  // Femme, à droite : tête, robe évasée en gradins, bras, deux jambes.
  const f = 1.7 * s;
  verticalDisc(box, f, z0 + 4.45 * s, 0.42 * s, fig, WC_WHITE);
  const dress = 5;
  for (let i = 0; i < dress; i++) {
    const z2 = z0 + 3.85 * s - (i * 1.4 * s) / dress;
    const z1 = z2 - (1.4 * s) / dress;
    box((0.38 + (0.55 * (i + 1)) / dress) * s, fig, z1, z2, WC_WHITE, f);
  }
  for (const side of [-1, 1]) {
    box(0.13 * s, fig, z0 + 2.95 * s, z0 + 3.75 * s, WC_WHITE, f + side * 0.75 * s);
    box(0.18 * s, fig, z0 + 1.3 * s, z0 + 2.45 * s, WC_WHITE, f + side * 0.28 * s);
  }
}

/**
 * Toilettes des pistes : cabane en bois à deux portes (bleue, rose), panneau géant
 * homme-femme sur le toit, et un rouleau de papier toilette géant posé dans la neige.
 */
function toiletBlock(box: Box, k: number, kv: number) {
  const L = 4.2 * k;
  const W = 2.6 * k;
  const wall = 3.3 * kv;
  box(L, W, 0, 0.6 * kv, STONE);
  box(L, W, 0.6 * kv, wall, WOOD[1]);
  // Deux portes côté +large, un peu en saillie, avec leur imposte blanche ; planche entre les deux.
  for (const [a, c] of [
    [-1.9 * k, BLUE],
    [1.9 * k, WC_PINK],
  ] as const) {
    box(0.75 * k, W + 0.1 * k, 0.6 * kv, 2.7 * kv, c, a);
    box(0.5 * k, W + 0.12 * k, 2.85 * kv, 3.1 * kv, WC_WHITE, a);
  }
  box(0.15 * k, W + 0.08 * k, 0.6 * kv, wall, DARK_WOOD);
  // Petite rampe d'accès devant les portes.
  box(L * 0.9, 0.9 * k, 0, 0.35 * kv, '#c9c3b8', 0, W + 0.9 * k);
  snowRoof(box, L, W, wall, k, kv, 3);
  toiletSign(box, k, wall + 3 * 0.9 * kv - 0.5 * kv);

  // Rouleau géant couché dans la neige, à côté de la cabane, et sa bande de papier déroulée.
  const ra = L + 3.2 * k;
  const r = 1.6 * k;
  const len = 1.5 * k;
  const slices = 8;
  for (let j = 0; j < slices; j++) {
    const y0 = -r + (2 * r * j) / slices;
    const y1 = y0 + (2 * r) / slices;
    const ym = (y0 + y1) / 2;
    const hw = Math.sqrt(Math.max(0, r * r - ym * ym));
    // Rouleau couché : axe dans le sens de la longueur, disque dans le plan (large, hauteur).
    box(len, hw, r + y0, r + y1, WC_WHITE, ra);
    const rc = 0.45 * k;
    if (Math.abs(ym) < rc) box(len + 0.05 * k, Math.sqrt(rc * rc - ym * ym), r + y0, r + y1, '#b08a5c', ra);
  }
  box(len * 0.9, 2.2 * k, 0, 0.08 * kv, WC_WHITE, ra, r + 2 * k);
}

/** Équipements de secours : poste de secours, borne d'urgence, défibrillateur, cabinet médical. */
function rescue(box: Box, poly: Poly, k: number, kv: number, kind: string) {
  if (kind === 'Défibrillateur' || kind === "Téléphone d'urgence") {
    const color = kind === 'Défibrillateur' ? GREEN : ORANGE;
    box(0.5 * k, 0.5 * k, 0, 2 * kv, color);
    box(0.7 * k, 0.7 * k, 2 * kv, 2.3 * kv, WHITE);
    return;
  }
  if (/pharmacie|médecin|médical|clinique|dentiste/i.test(kind)) {
    const L = 8 * k;
    const W = 6 * k;
    box(L, W, 0, 5 * kv, WHITE);
    box(L + 0.2 * k, W + 0.2 * k, 4 * kv, 4.8 * kv, kind === 'Pharmacie' ? GREEN : RED);
    snowRoof(box, L, W, 5 * kv, k, kv, 3);
    return;
  }
  skiPatrol(box, poly, k, kv);
}

/**
 * Panneau « secours » géant sur le faîte : grand carré blanc cerclé de rouge, croix rouge en relief,
 * dans le plan vertical du faîte. `z0` : haut du toit.
 */
function rescueSign(box: Box, scale: number, z0: number) {
  const s = scale * 1.3;
  const fig = 0.24 * s;
  box(0.18 * s, 0.18 * s, z0, z0 + 0.8 * s, '#495057');
  box(2.4 * s, 0.12 * s, z0 + 0.8 * s, z0 + 5.6 * s, RED);
  box(2.1 * s, 0.16 * s, z0 + 1.1 * s, z0 + 5.3 * s, WHITE);
  // Croix : barre verticale et barre horizontale.
  box(0.5 * s, fig, z0 + 1.6 * s, z0 + 4.8 * s, RED);
  box(1.6 * s, fig, z0 + 2.7 * s, z0 + 3.7 * s, RED);
}

/**
 * Poste de secours des pistes : chalet blanc à bandeau rouge, porte rouge, panneau géant à croix
 * rouge sur le toit, barquette de secours garée devant, hélisurface (grand « H ») et manche à air.
 */
function skiPatrol(box: Box, poly: Poly, k: number, kv: number) {
  const L = 6 * k;
  const W = 4.2 * k;
  const wall = 4 * kv;
  box(L, W, 0, 0.6 * kv, STONE);
  box(L, W, 0.6 * kv, wall, WHITE);
  box(L + 0.15 * k, W + 0.15 * k, 2.7 * kv, 3.5 * kv, RED);
  // Fenêtres et porte rouge sur la façade (côté +large), garage à barquettes sur le pignon.
  for (const a of [-L * 0.5, L * 0.15]) box(0.7 * k, W + 0.08 * k, 1.3 * kv, 2.5 * kv, GLASS, a);
  box(0.6 * k, W + 0.12 * k, 0.6 * kv, 2.6 * kv, RED, L * 0.62);
  box(L + 0.1 * k, 1.6 * k, 0.6 * kv, 2.4 * kv, '#ced4da');
  snowRoof(box, L, W, wall, k, kv, 3);
  rescueSign(box, k, wall + 3 * 0.9 * kv - 0.5 * kv);

  // Barquette de secours (traîneau-coque rouge) devant la façade, brancards vers la pente.
  const ba = -L * 0.2;
  const br = W + 2.4 * k;
  const hull: [number, number][] = [
    [ba - 1.4 * k, br - 0.45 * k],
    [ba + 1 * k, br - 0.45 * k],
    [ba + 1.5 * k, br],
    [ba + 1 * k, br + 0.45 * k],
    [ba - 1.4 * k, br + 0.45 * k],
  ];
  poly(hull, 0, 0.45 * kv, RED);
  box(1 * k, 0.3 * k, 0.45 * kv, 0.55 * kv, WHITE, ba - 0.2 * k, br);
  for (const side of [-1, 1]) box(0.9 * k, 0.05 * k, 0.4 * kv, 0.5 * kv, STEEL, ba - 2.2 * k, br + side * 0.38 * k);

  // Hélisurface : disque clair cerclé de rouge, grand « H » rouge, posé sur la neige.
  const ha = L + 9 * k;
  const ring = (radius: number) =>
    Array.from({ length: 16 }, (_, i) => {
      const t = (i / 16) * Math.PI * 2;
      return [ha + Math.cos(t) * radius, Math.sin(t) * radius] as [number, number];
    });
  poly(ring(5.5 * k), 0, 0.08 * kv, RED);
  poly(ring(4.9 * k), 0.08 * kv, 0.12 * kv, '#f1f3f5');
  for (const side of [-1, 1]) box(1.8 * k, 0.45 * k, 0.12 * kv, 0.16 * kv, RED, ha, side * 1.3 * k);
  box(0.4 * k, 0.9 * k, 0.12 * kv, 0.16 * kv, RED, ha);

  // Manche à air rouge et blanche en haut d'un mât, au bord de l'hélisurface.
  const wa = ha;
  const wr = -6.8 * k;
  box(0.08 * k, 0.08 * k, 0, 7 * kv, STEEL, wa, wr);
  [RED, WHITE, RED, WHITE].forEach((c, i) => {
    const w = (0.38 - i * 0.06) * k;
    box(0.35 * k, w, 6.5 * kv - w, 6.5 * kv + w, c, wa + 0.2 * k + i * 0.7 * k, wr);
  });
}

/** Deux tables de pique-nique avec leurs bancs. */
function picnic(box: Box, k: number, kv: number) {
  for (const dx of [-2.6 * k, 2.6 * k]) {
    box(1.8 * k, 0.9 * k, 0.65 * kv, 0.85 * kv, WOOD[3], dx);
    box(0.25 * k, 0.6 * k, 0, 0.65 * kv, DARK_WOOD, dx - 1.3 * k);
    box(0.25 * k, 0.6 * k, 0, 0.65 * kv, DARK_WOOD, dx + 1.3 * k);
    for (const dy of [-1.5 * k, 1.5 * k]) box(1.8 * k, 0.35 * k, 0, 0.5 * kv, DARK_WOOD, dx, dy);
  }
}

/** Belvédère : plateforme en bois avec garde-corps et table d'orientation. */
const BINOCULAR = '#343a40';
const BINOCULAR_TRIM = '#868e96';
const LENS = '#4dabf7';

/**
 * Cylindre couché, axe dans le sens de la longueur : tranches horizontales dont la largeur suit
 * le cercle. `a`, `r` : centre ; `zc` : hauteur de l'axe ; `half` : demi-longueur.
 */
function lyingCylinder(box: Box, a: number, r: number, zc: number, radius: number, half: number, c: string, slices = 8) {
  for (let j = 0; j < slices; j++) {
    const y0 = -radius + (2 * radius * j) / slices;
    const y1 = y0 + (2 * radius) / slices;
    const ym = (y0 + y1) / 2;
    box(half, Math.sqrt(Math.max(0, radius * radius - ym * ym)), zc + y0, zc + y1, c, a, r);
  }
}

/** Jumelles géantes posées sur un pied, braquées vers l'extérieur du belvédère (sens +longueur). */
function giantBinoculars(box: Box, scale: number, a: number, base: number) {
  const s = scale * 1.4;
  const zc = base + 3.3 * s;
  // Pied et rotule.
  box(0.3 * s, 0.3 * s, base, zc - 0.6 * s, BINOCULAR_TRIM, a);
  box(0.55 * s, 0.55 * s, zc - 0.75 * s, zc - 0.45 * s, BINOCULAR, a);
  for (const side of [-1, 1]) {
    const r = side * 0.95 * s;
    // Corps, objectif plus large à l'avant (lentille bleue), oculaire plus fin à l'arrière.
    lyingCylinder(box, a, r, zc, 0.72 * s, 1.1 * s, BINOCULAR);
    lyingCylinder(box, a + 1.35 * s, r, zc, 0.86 * s, 0.3 * s, BINOCULAR_TRIM);
    lyingCylinder(box, a + 1.68 * s, r, zc, 0.62 * s, 0.05 * s, LENS);
    lyingCylinder(box, a - 1.4 * s, r, zc, 0.38 * s, 0.35 * s, BINOCULAR_TRIM, 6);
  }
  // Pont entre les deux corps, et molette de mise au point.
  box(0.5 * s, 0.95 * s, zc - 0.25 * s, zc + 0.25 * s, BINOCULAR, a - 0.2 * s);
  lyingCylinder(box, a - 0.2 * s, 0, zc + 0.45 * s, 0.25 * s, 0.35 * s, BINOCULAR_TRIM, 4);
}

/**
 * Belvédère : plateforme octogonale en bois sur socle de pierre, garde-corps ouvert à l'arrière,
 * jumelles géantes braquées sur le panorama, table d'orientation et banc.
 */
function viewpoint(box: Box, poly: Poly, k: number, kv: number) {
  const R = 5 * k;
  const octagon = (radius: number) =>
    Array.from({ length: 8 }, (_, i) => {
      const t = (i / 8) * Math.PI * 2 + Math.PI / 8;
      return [Math.cos(t) * radius, Math.sin(t) * radius] as [number, number];
    });
  const deck = 0.7 * kv;
  poly(octagon(R + 0.3 * k), 0, 0.35 * kv, STONE);
  poly(octagon(R), 0.35 * kv, deck, WOOD[0]);
  // Garde-corps : poteaux aux angles, lisse sur les côtés tournés vers le vide (l'arrière reste ouvert).
  const corners = octagon(R - 0.2 * k);
  corners.forEach(([a, r], i) => {
    box(0.12 * k, 0.12 * k, deck, deck + 1.2 * kv, DARK_WOOD, a, r);
    const [na, nr] = corners[(i + 1) % 8];
    if (Math.min(a, na) < -R * 0.6) return; // côté de l'accès
    // Lisses haute et intermédiaire : bandes minces d'un poteau à l'autre.
    const len = Math.hypot(na - a, nr - r);
    const [pa, pr] = [(-(nr - r) / len) * 0.06 * k, ((na - a) / len) * 0.06 * k];
    const rail: [number, number][] = [
      [a + pa, r + pr],
      [na + pa, nr + pr],
      [na - pa, nr - pr],
      [a - pa, r - pr],
    ];
    poly(rail, deck + 1.05 * kv, deck + 1.2 * kv, DARK_WOOD);
    poly(rail, deck + 0.55 * kv, deck + 0.65 * kv, DARK_WOOD);
  });
  giantBinoculars(box, k, R * 0.35, deck);
  // Table d'orientation (pupitre de pierre, plateau clair) et banc à l'arrière.
  box(0.45 * k, 0.45 * k, deck, deck + 1 * kv, STONE, -R * 0.15, R * 0.45);
  poly(
    octagon(0.75 * k).map(([a, r]) => [a - R * 0.15, r + R * 0.45] as [number, number]),
    deck + 1 * kv,
    deck + 1.15 * kv,
    '#d9d3c7',
  );
  box(0.35 * k, 1.6 * k, deck, deck + 0.5 * kv, WOOD[3], -R * 0.55, -R * 0.2);
}

const SHOP_BANDS: Partial<Record<DomainPoiCategoryId, string>> = {
  ski: '#1c7ed6',
  shop: '#9c36b5',
  grocery: '#2f9e44',
  services: '#495057',
  info: '#1c7ed6',
  leisure: '#0ca678',
};

function model(out: Volume[], p: DomainPoi, k: number) {
  const kv = Math.sqrt(k);
  const { box, poly, seed } = builder(out, p);
  switch (p.category) {
    case 'restaurant':
      return restaurant(box, poly, seed, k, kv);
    case 'hut':
      return refuge(box, seed, k, kv);
    case 'bar':
      return chalet(box, seed, k, kv, 0.75);
    case 'lodging':
      return p.kind === 'Chalet' ? chalet(box, seed, k, kv, 0.9) : lodge(box, seed, k, kv);
    case 'toilets':
      return toilets(box, k, kv, p.kind !== 'Toilettes');
    case 'rescue':
      return rescue(box, poly, k, kv, p.kind);
    case 'picnic':
      return picnic(box, k, kv);
    case 'viewpoint':
      return viewpoint(box, poly, k, kv);
    default:
      return shop(box, seed, k, kv, SHOP_BANDS[p.category] ?? STONE);
  }
}

/** Bâtiments assez grands pour avaler des toilettes posées au même endroit dans OSM. */
const BIG_BUILDINGS = new Set<DomainPoiCategoryId>(['restaurant', 'hut', 'bar', 'lodging']);
/** Toilettes et postes de secours à moins de cette distance d'un grand bâtiment : écartés. */
const TOILET_CLASH_M = 40;
/** Écart appliqué selon le lieu (mètres au zoom de référence ; grandit avec les modèles en dézoomant). */
const NUDGE_M: Partial<Record<DomainPoiCategoryId, number>> = { toilets: 30, rescue: 40 };

/**
 * Toilettes et postes de secours à écarter d'un grand bâtiment voisin (souvent posés au
 * même point dans OSM) : direction unitaire [est, nord] pour s'en éloigner.
 */
function toiletNudges(places: DomainPoi[]): Map<string, [number, number]> {
  const nudges = new Map<string, [number, number]>();
  const big = places.filter((q) => BIG_BUILDINGS.has(q.category));
  for (const p of places) {
    const nudgeable = (p.category === 'toilets' && p.kind === 'Toilettes') || (p.category === 'rescue' && /secours/i.test(p.kind));
    if (!nudgeable) continue;
    const mx = metersPerDegLng(p.lat);
    let best: [number, number] | null = null;
    let bestD = TOILET_CLASH_M;
    for (const q of big) {
      const dx = (p.lng - q.lng) * mx;
      const dy = (p.lat - q.lat) * METERS_PER_DEG_LAT;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        // Même point : direction stable tirée de l'identifiant.
        const angle = hash(p.id) * Math.PI * 2;
        best = d > 1 ? [dx / d, dy / d] : [Math.cos(angle), Math.sin(angle)];
      }
    }
    if (best) nudges.set(p.id, best);
  }
  return nudges;
}

/** Rayon (m) de la clairière ouverte dans la forêt autour de chaque modèle, terrasse comprise. */
const CLEARING_M: Partial<Record<DomainPoiCategoryId, number>> = { restaurant: 32, hut: 20, lodging: 22, viewpoint: 14, bar: 16, rescue: 24 };

/** Clairières des lieux modélisés : pas de sapin 3D à travers un chalet ou un belvédère. */
export function placeClearings(places: DomainPoi[]): { coordinates: number[][]; halfWidth: number }[] {
  return places.map((p) => ({ coordinates: [[p.lng, p.lat], [p.lng, p.lat]], halfWidth: CLEARING_M[p.category] ?? 12 }));
}

/**
 * Volumes de tous les lieux modélisés à l'échelle `k` (1 : dimensions de référence). Partagé par
 * la carte MapLibre (calque fill-extrusion) et la carte Three.js (src/components/three/buildings.ts).
 */
export function placeVolumes(places: DomainPoi[], k: number): PlaceVolume[] {
  const nudges = toiletNudges(places);
  const out: Volume[] = [];
  places.forEach((p) => {
    const nudge = nudges.get(p.id);
    if (!nudge) return model(out, p, k);
    // Toilettes ou poste de secours collés à un restaurant : décalés à côté de lui (terrasse comprise).
    const d = (NUDGE_M[p.category] ?? 30) * k;
    model(out, { ...p, lng: p.lng + (nudge[0] * d) / metersPerDegLng(p.lat), lat: p.lat + (nudge[1] * d) / METERS_PER_DEG_LAT }, k);
  });
  return out;
}

/** Ajoute le calque des bâtiments des lieux ; renvoie la fonction d'arrêt. */
export function addPlaceBuildings(map: MlMap, places: DomainPoi[], beforeId?: string): () => void {
  const empty: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] };
  map.addSource(BUILDINGS_LAYER, { type: 'geojson', data: empty, tolerance: 0 });
  map.addLayer(
    {
      id: BUILDINGS_LAYER,
      type: 'fill-extrusion',
      source: BUILDINGS_LAYER,
      minzoom: MIN_ZOOM,
      // Rien d'affiché tant que le filtre des catégories cochées n'est pas posé.
      filter: ['==', ['get', 'cat'], ''],
      paint: {
        'fill-extrusion-color': ['get', 'c'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true,
      },
    },
    beforeId,
  );
  const source = map.getSource(BUILDINGS_LAYER) as GeoJSONSource;
  let lastK = 0;
  const update = () => {
    if (map.getZoom() < MIN_ZOOM) return;
    const k = Math.min(MAX_SCALE, Math.max(1, 2 ** (REF_ZOOM - Math.round(map.getZoom() * 2) / 2)));
    if (k === lastK) return;
    lastK = k;
    source.setData({ type: 'FeatureCollection', features: placeVolumes(places, k) });
  };
  update();
  map.on('zoomend', update);
  return () => map.off('zoomend', update);
}
