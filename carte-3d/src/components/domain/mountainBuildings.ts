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
import { METERS_PER_DEG_LAT, metersPerDegLng } from '@/components/station/map3d';

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

type Volume = FeatureCollection<Polygon, { c: string; b: number; h: number; cat: string }>['features'][number];

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
  return { box, seed };
}

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
  box(3 * k, 2.2 * k, 0, 3 * kv, WOOD[1]);
  // Panneau « WC » bleu au-dessus de la porte.
  box(0.25 * k, 1.2 * k, 2 * kv, 2.7 * kv, BLUE, 3.1 * k);
  snowRoof(box, 3 * k, 2.2 * k, 3 * kv, k, kv, 3);
}

/** Équipements de secours : poste de secours, borne d'urgence, défibrillateur, cabinet médical. */
function rescue(box: Box, k: number, kv: number, kind: string) {
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
  // Poste de secours des pistes : cabane blanche à bandeau rouge, mât et drapeau rouge.
  const L = 5.5 * k;
  const W = 4 * k;
  box(L, W, 0, 3.6 * kv, WHITE);
  box(L + 0.2 * k, W + 0.2 * k, 2.6 * kv, 3.4 * kv, RED);
  snowRoof(box, L, W, 3.6 * kv, k, kv, 3);
  box(0.2 * k, 0.2 * k, 0, 9 * kv, STEEL, L + 2 * k);
  box(0.12 * k, 1.2 * k, 7.6 * kv, 8.8 * kv, RED, L + 2 * k, 1.3 * k);
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
function viewpoint(box: Box, k: number, kv: number) {
  const L = 4 * k;
  const W = 3 * k;
  box(L, W, 0, 0.5 * kv, WOOD[0]);
  box(0.12 * k, W, 0.5 * kv, 1.6 * kv, DARK_WOOD, L);
  box(L, 0.12 * k, 0.5 * kv, 1.6 * kv, DARK_WOOD, 0, W);
  box(L, 0.12 * k, 0.5 * kv, 1.6 * kv, DARK_WOOD, 0, -W);
  box(0.6 * k, 0.6 * k, 0.5 * kv, 1.6 * kv, STONE);
  box(0.9 * k, 0.9 * k, 1.6 * kv, 1.8 * kv, '#d9d3c7');
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
  const { box, seed } = builder(out, p);
  switch (p.category) {
    case 'restaurant':
    case 'hut':
      return chalet(box, seed, k, kv);
    case 'bar':
      return chalet(box, seed, k, kv, 0.75);
    case 'lodging':
      return p.kind === 'Chalet' ? chalet(box, seed, k, kv, 0.9) : lodge(box, seed, k, kv);
    case 'toilets':
      return toilets(box, k, kv, p.kind !== 'Toilettes');
    case 'rescue':
      return rescue(box, k, kv, p.kind);
    case 'picnic':
      return picnic(box, k, kv);
    case 'viewpoint':
      return viewpoint(box, k, kv);
    default:
      return shop(box, seed, k, kv, SHOP_BANDS[p.category] ?? STONE);
  }
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
    const out: Volume[] = [];
    places.forEach((p) => model(out, p, k));
    source.setData({ type: 'FeatureCollection', features: out });
  };
  update();
  map.on('zoomend', update);
  return () => map.off('zoomend', update);
}
