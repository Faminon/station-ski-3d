// Remontées mécaniques en 3D sur les cartes MapLibre : câbles et pylônes
// surélevés, gares, télécabines, télésièges, téléphériques et perches, immobiles.
// Tout est dessiné en « fill-extrusion » (volumes posés sur le relief), sans
// moteur 3D supplémentaire.
//
// MapLibre pose chaque volume à l'altitude du terrain sous son centre : les
// câbles sont donc découpés en tronçons courts, et chacun est étiré en hauteur
// d'après le relief à ses deux bouts, pour former un trait continu en pente.
//
// Échelle : à fort zoom, les objets ont des dimensions proches du réel (un peu
// grossies pour rester visibles) ; en dézoomant, ils grossissent et s'espacent,
// pour rester lisibles sans multiplier les volumes redessinés à chaque image.

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { METERS_PER_DEG_LAT, metersPerDegLng } from './map3d';

/** Calques ajoutés à la carte, à masquer avec les remontées. */
export const LIFT_3D_LAYERS = ['lift-structures', 'lift-cabins'];

/** En dessous de ce zoom, les remontées restent de simples traits. */
const MIN_ZOOM = 12.5;
/** Zoom auquel les objets ont leurs dimensions de référence (proches du réel). */
const REF_ZOOM = 15.5;
const MAX_SCALE = 8;
/** Plafond de cabines dessinées : au-delà, les remontées les plus éloignées restent de simples traits. */
const CABIN_BUDGET = 2400;
const MIN_LENGTH_M = 80;
/** Écart entre deux perches de tire-fesses, à l'échelle de référence (m) : assez large pour qu'on suive chacune du regard. */
const DRAG_SPACING = 30;
/** Délai minimal entre deux recalculs des volumes fixes quand des tuiles de relief plus fines arrivent. */
const STRUCTURES_REFRESH_MS = 1500;

type Kind = 'gondola' | 'chair' | 'mixed' | 'tram' | 'drag';
const KINDS: Record<string, Kind> = {
  gondola: 'gondola', chair_lift: 'chair', mixed_lift: 'mixed', cable_car: 'tram',
  // Tire-fesses : câble bas sur petits poteaux, perches à assiette.
  platter: 'drag', drag_lift: 'drag', 't-bar': 'drag', 'j-bar': 'drag', rope_tow: 'drag',
};

/** Dimensions d'un tire-fesses : câble à quelques mètres du sol, voies rapprochées. */
// Volumes grossis (×2,5 environ) : à taille réelle, une perche ne fait que 1 ou 2 pixels même de près.
const dragScale = (s: Scale): Scale => ({ ...s, H: 7 * s.kv, off: 2.2 * s.k });

const COLORS = ['#e03131', '#1c7ed6', '#f08c00', '#2f9e44', '#f1f3f5', '#ae3ec9', '#fab005'];
const STEEL = '#5c636a';
const CABLE = '#212529';
const CONCRETE = '#ced4da';
const ROOF = '#495057';
const SEAT = '#343a40';
const PERCH = '#f8f9fa';
/** Assiettes des perches : couleurs vives, lisibles sur la neige comme sur l'herbe. */
const DRAG_DISC = ['#e03131', '#f08c00', '#1c7ed6', '#ae3ec9'];

/** Tracé d'une remontée en longitude / latitude, dessiné de l'aval vers l'amont (convention OpenStreetMap). */
export interface LiftLine {
  name: string;
  liftType: string;
  coordinates: number[][];
}

interface Lift {
  kind: Kind;
  key: string;
  /** Repère métrique local : origine au départ, x vers l'est, y vers le nord. */
  lng0: number;
  lat0: number;
  mx: number;
  xs: number[];
  ys: number[];
  /** Distance cumulée depuis le départ, à chaque point. */
  cum: number[];
  length: number;
  color: string;
  /** Décalage de phase (0–1), pour que les remontées ne tournent pas en cadence. */
  seed: number;
  /** [ouest, sud, est, nord] */
  bbox: [number, number, number, number];
}

type Volume = Feature<Polygon, { c: string; b: number; h: number }>;

/** Dimensions à l'échelle courante : `k` pour les longueurs au sol, `kv` (plus modéré) pour les hauteurs. */
interface Scale {
  k: number;
  kv: number;
  /** Hauteur des câbles au-dessus du sol. */
  H: number;
  /** Écart de chaque voie (montée, descente) à l'axe du tracé. */
  off: number;
}

function scaleFor(zoom: number): Scale {
  // Par quarts de zoom : les volumes fixes ne sont recalculés qu'à ces paliers.
  const k = Math.min(MAX_SCALE, Math.max(1, 2 ** (REF_ZOOM - Math.round(zoom * 4) / 4)));
  const kv = Math.sqrt(k);
  return { k, kv, H: 15 * kv, off: 3.5 * k };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

function prepare(lines: LiftLine[]): Lift[] {
  const lifts: Lift[] = [];
  for (const line of lines) {
    const kind = KINDS[line.liftType];
    if (!kind || line.coordinates.length < 2) continue;
    const [lng0, lat0] = line.coordinates[0];
    const mx = metersPerDegLng(lat0);
    const xs = line.coordinates.map(([lng]) => (lng - lng0) * mx);
    const ys = line.coordinates.map(([, lat]) => (lat - lat0) * METERS_PER_DEG_LAT);
    const cum = [0];
    for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
    const length = cum[cum.length - 1];
    if (length < MIN_LENGTH_M) continue;
    const lngs = line.coordinates.map(([lng]) => lng);
    const lats = line.coordinates.map(([, lat]) => lat);
    const seed = hash(`${line.name}|${lng0}|${lat0}`);
    lifts.push({
      kind,
      key: String(lifts.length),
      lng0,
      lat0,
      mx,
      xs,
      ys,
      cum,
      length,
      color: COLORS[Math.floor(seed * COLORS.length)],
      seed,
      bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    });
  }
  return lifts;
}

/** Point du tracé à la distance `d` du départ, avec la direction de montée (vecteur unitaire). */
function pointAt(l: Lift, d: number) {
  const dd = Math.max(0, Math.min(l.length, d));
  let i = 1;
  while (i < l.cum.length - 1 && l.cum[i] < dd) i++;
  const seg = l.cum[i] - l.cum[i - 1] || 1;
  const t = (dd - l.cum[i - 1]) / seg;
  const dx = l.xs[i] - l.xs[i - 1];
  const dy = l.ys[i] - l.ys[i - 1];
  return { x: l.xs[i - 1] + dx * t, y: l.ys[i - 1] + dy * t, ux: dx / seg, uy: dy / seg };
}

/**
 * Volume rectangulaire centré en (x, y), orienté selon la direction (ux, uy).
 * `along` et `across` sont des demi-dimensions ; `b` et `h`, les hauteurs du
 * bas et du haut au-dessus du sol.
 */
function box(out: Volume[], l: Lift, x: number, y: number, ux: number, uy: number, along: number, across: number, b: number, h: number, c: string) {
  // (uy, -ux) : à droite du sens de la montée.
  const corner = (sa: number, sr: number) => [
    l.lng0 + (x + ux * along * sa + uy * across * sr) / l.mx,
    l.lat0 + (y + uy * along * sa - ux * across * sr) / METERS_PER_DEG_LAT,
  ];
  const ring = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
  ring.push(ring[0]);
  out.push({ type: 'Feature', properties: { c, b, h }, geometry: { type: 'Polygon', coordinates: [ring] } });
}

/** Altitude du terrain (relief exagéré, tel que dessiné) en un point du repère local, ou null tant que la tuile manque. */
type Elevation = (l: Lift, x: number, y: number) => number | null;

/** Volumes fixes : câbles (montée à droite, descente à gauche), pylônes et gares aux deux bouts. */
function addStructures(out: Volume[], l: Lift, scale: Scale, elevation: Elevation) {
  const drag = l.kind === 'drag';
  const s = drag ? dragScale(scale) : scale;
  const { k, kv, H, off } = s;
  const pieces = Math.max(1, Math.round(l.length / (4 * k)));
  const step = l.length / pieces;
  const ends = Array.from({ length: pieces + 1 }, (_, i) => {
    const p = pointAt(l, i * step);
    return elevation(l, p.x, p.y);
  });
  for (let i = 0; i < pieces; i++) {
    const p = pointAt(l, (i + 0.5) * step);
    // Hauteurs relatives au sol sous le centre du tronçon : on l'étire pour
    // rejoindre ses voisins, au lieu d'une marche d'escalier sur les pentes.
    // Sol sous le centre : moyenne des deux bouts, à quelques mètres près (deux fois moins de lectures du relief).
    const [a, z] = [ends[i], ends[i + 1]];
    const ok = a !== null && z !== null;
    const half = ok ? Math.abs(z - a) / 2 : 0;
    const [low, high] = [-half, half];
    // Tire-fesses : pas de câble en 3D (ses tronçons étirés dans la pente formaient un peigne qui
    // masquait les perches) ; le trait au sol et les poteaux suffisent à le situer.
    if (drag) continue;
    for (const side of [1, -1]) {
      box(out, l, p.x + p.uy * off * side, p.y - p.ux * off * side, p.ux, p.uy, step * 0.55, 0.35 * k, H - 0.5 * kv + low, H + high, CABLE);
    }
  }

  if (drag) {
    // Tire-fesses : petits poteaux rapprochés, gares réduites à deux cabanons.
    const posts = Math.max(2, Math.round(l.length / 70));
    for (let j = 1; j < posts; j++) {
      const p = pointAt(l, (l.length * j) / posts);
      box(out, l, p.x, p.y, p.ux, p.uy, 0.7 * k, 0.7 * k, 0, H + 0.5 * kv, STEEL);
      box(out, l, p.x, p.y, p.ux, p.uy, 0.6 * k, off + 1 * k, H - 0.4 * kv, H + 0.5 * kv, STEEL);
    }
    for (const [d, outward] of [[0, -1], [l.length, 1]]) {
      const p = pointAt(l, d);
      const x = p.x + p.ux * 3 * k * outward;
      const y = p.y + p.uy * 3 * k * outward;
      box(out, l, x, y, p.ux, p.uy, 3.5 * k, off + 2.5 * k, 0, H + 1 * kv, CONCRETE);
      box(out, l, x, y, p.ux, p.uy, 4 * k, off + 3 * k, H + 1 * kv, H + 1.8 * kv, ROOF);
    }
    return;
  }

  // Un pylône tous les 230 m environ (au moins un au milieu).
  const spans = Math.max(2, Math.round(l.length / 230));
  for (let j = 1; j < spans; j++) {
    const p = pointAt(l, (l.length * j) / spans);
    box(out, l, p.x, p.y, p.ux, p.uy, 0.9 * k, 0.9 * k, 0, H + 0.4 * kv, STEEL);
    box(out, l, p.x, p.y, p.ux, p.uy, 0.6 * k, off + 1.2 * k, H - 0.5 * kv, H + 0.4 * kv, STEEL);
  }

  // Gares : décalées vers l'extérieur du tracé, elles abritent le demi-tour des cabines.
  for (const [d, outward] of [[0, -1], [l.length, 1]]) {
    const p = pointAt(l, d);
    const x = p.x + p.ux * 4 * k * outward;
    const y = p.y + p.uy * 4 * k * outward;
    box(out, l, x, y, p.ux, p.uy, 7 * k, off + 3.5 * k, 0, H + 2 * kv, CONCRETE);
    box(out, l, x, y, p.ux, p.uy, 7.6 * k, off + 4.1 * k, H + 2 * kv, H + 2.8 * kv, ROOF);
  }
}

/** Accélération et freinage aux gares, avec un arrêt à quai à chaque bout. */
function ease(t: number): number {
  const u = Math.max(0, Math.min(1, (t - 0.06) / 0.88));
  return u * u * (3 - 2 * u);
}

/** Volumes animés : position de chaque véhicule après `travel` mètres de câble parcourus. */
function addVehicles(out: Volume[], l: Lift, scale: Scale, travel: number) {
  const s = l.kind === 'drag' ? dragScale(scale) : scale;
  const { k, kv, H, off } = s;

  if (l.kind === 'drag') {
    // Tire-fesses : perches serrées. À la montée, tige jusqu'au sol et assiette colorée ;
    // au retour, perche repliée sous le câble.
    const loop = 2 * l.length;
    const n = Math.max(2, Math.round(loop / (DRAG_SPACING * k)));
    for (let i = 0; i < n; i++) {
      const pos = (((travel + l.seed * loop + (i * loop) / n) % loop) + loop) % loop;
      const up = pos < l.length;
      const p = pointAt(l, up ? pos : loop - pos);
      const side = up ? 1 : -1;
      const x = p.x + p.uy * off * side;
      const y = p.y - p.ux * off * side;
      // Perches blanches, assiettes de couleurs alternées : on voit la file avancer.
      if (up) {
        box(out, l, x, y, p.ux, p.uy, 0.4 * k, 0.4 * k, 1.6 * kv, H, PERCH);
        box(out, l, x, y, p.ux, p.uy, 1.6 * k, 1.6 * k, 0.6 * kv, 1.6 * kv, DRAG_DISC[i % DRAG_DISC.length]);
      } else {
        box(out, l, x, y, p.ux, p.uy, 0.4 * k, 0.4 * k, H - 2.2 * kv, H, PERCH);
        box(out, l, x, y, p.ux, p.uy, 1 * k, 1 * k, H - 2.8 * kv, H - 2.2 * kv, DRAG_DISC[i % DRAG_DISC.length]);
      }
    }
    return;
  }

  if (l.kind === 'tram') {
    // Téléphérique : deux grandes cabines en va-et-vient, qui se croisent à mi-parcours.
    const cycle = (((travel / l.length + l.seed * 2) % 2) + 2) % 2;
    const e = ease(cycle < 1 ? cycle : 2 - cycle);
    for (const [d, side] of [[l.length * e, 1], [l.length * (1 - e), -1]]) {
      const p = pointAt(l, d);
      const x = p.x + p.uy * off * side;
      const y = p.y - p.ux * off * side;
      box(out, l, x, y, p.ux, p.uy, 1.5 * k, 0.6 * k, H - 3 * kv, H + 0.4 * kv, STEEL);
      box(out, l, x, y, p.ux, p.uy, 3.5 * k, 2.6 * k, H - 7.5 * kv, H - 3 * kv, l.color);
    }
    return;
  }

  // Débrayables : boucle continue, montée d'un côté, descente de l'autre.
  const loop = 2 * l.length;
  const spacing = (l.kind === 'chair' ? 38 : 75) * k;
  const n = Math.max(2, Math.round(loop / spacing));
  for (let i = 0; i < n; i++) {
    const pos = (((travel + l.seed * loop + (i * loop) / n) % loop) + loop) % loop;
    const up = pos < l.length;
    const p = pointAt(l, up ? pos : loop - pos);
    const side = up ? 1 : -1;
    const x = p.x + p.uy * off * side;
    const y = p.y - p.ux * off * side;

    if (l.kind === 'chair' || (l.kind === 'mixed' && i % 3 !== 0)) {
      // Télésiège : suspente, assise, et dossier à l'arrière dans le sens de la marche.
      const back = up ? -1 : 1;
      box(out, l, x, y, p.ux, p.uy, 0.2 * k, 0.2 * k, H - 4 * kv, H, STEEL);
      box(out, l, x, y, p.ux, p.uy, 0.9 * k, 2.6 * k, H - 4.6 * kv, H - 4 * kv, SEAT);
      box(out, l, x + p.ux * 0.75 * k * back, y + p.uy * 0.75 * k * back, p.ux, p.uy, 0.2 * k, 2.6 * k, H - 4.6 * kv, H - 2.8 * kv, l.color);
    } else {
      // Télécabine : suspente et cabine.
      box(out, l, x, y, p.ux, p.uy, 0.25 * k, 0.25 * k, H - 2.2 * kv, H, STEEL);
      box(out, l, x, y, p.ux, p.uy, 2.2 * k, 2 * k, H - 6.2 * kv, H - 2.2 * kv, l.color);
    }
  }
}

/** Nombre approximatif de volumes animés d'une remontée, pour respecter le budget par image. */
function vehicleCost(l: Lift, k: number): number {
  if (l.kind === 'tram') return 4;
  if (l.kind === 'drag') return Math.max(2, Math.round((2 * l.length) / (DRAG_SPACING * k))) * 2;
  const spacing = (l.kind === 'chair' ? 38 : 75) * k;
  return Math.max(2, Math.round((2 * l.length) / spacing)) * (l.kind === 'gondola' ? 2 : 3);
}

const collection = (features: Volume[]): FeatureCollection<Polygon> => ({ type: 'FeatureCollection', features });

export interface LiftsController {
  /** À appeler avant `map.remove()`. */
  stop(): void;
}

/**
 * Ajoute les remontées en 3D, immobiles, à une carte dont le style est chargé.
 * Les calques suivent la visibilité de `lift-cabins` (à masquer avec les autres
 * calques des remontées).
 *
 * Aucune animation : les volumes ne sont recalculés que lorsque la vue change de
 * palier de zoom ou de remontées visibles, ou quand un relief plus fin arrive.
 */
export function addLifts3d(map: MlMap, lines: LiftLine[]): LiftsController {
  const lifts = prepare(lines);
  for (const id of LIFT_3D_LAYERS) {
    // `tolerance: 0` : sans quoi la simplification des tuiles écrase les petits volumes.
    map.addSource(id, { type: 'geojson', data: collection([]), tolerance: 0 });
    map.addLayer({
      id,
      type: 'fill-extrusion',
      source: id,
      minzoom: MIN_ZOOM,
      paint: {
        'fill-extrusion-color': ['get', 'c'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true,
      },
    });
  }
  const structures = map.getSource('lift-structures') as GeoJSONSource;
  const vehicles = map.getSource('lift-cabins') as GeoJSONSource;

  let drawnKey = '';
  let drawnAt = 0;
  let cleared = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terrainTimer: ReturnType<typeof setTimeout> | undefined;
  // Les câbles suivent le relief chargé : on les recale quand des tuiles d'altitude arrivent.
  let terrainChanged = false;

  const elevation: Elevation = (l, x, y) => map.queryTerrainElevation([l.lng0 + x / l.mx, l.lat0 + y / METERS_PER_DEG_LAT]);

  /** Remontées visibles, les plus proches du centre d'abord, dans la limite du budget. */
  const inView = (k: number): Lift[] => {
    const b = map.getBounds();
    const c = map.getCenter();
    const [w, south, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const dist = (l: Lift) => Math.hypot((l.bbox[0] + l.bbox[2]) / 2 - c.lng, (l.bbox[1] + l.bbox[3]) / 2 - c.lat);
    const candidates = lifts.filter((l) => l.bbox[0] <= e && l.bbox[2] >= w && l.bbox[1] <= n && l.bbox[3] >= south).sort((a, z) => dist(a) - dist(z));
    const shown: Lift[] = [];
    let budget = CABIN_BUDGET;
    for (const l of candidates) {
      budget -= vehicleCost(l, k);
      if (budget < 0) break;
      shown.push(l);
    }
    return shown;
  };

  function draw() {
    timer = undefined;
    const zoom = map.getZoom();
    const visible = zoom >= MIN_ZOOM && map.getLayer('lift-cabins') && map.getLayoutProperty('lift-cabins', 'visibility') !== 'none';
    if (!visible) {
      if (!cleared) {
        structures.setData(collection([]));
        vehicles.setData(collection([]));
        drawnKey = '';
        cleared = true;
      }
      return;
    }
    const s = scaleFor(zoom);
    const shown = inView(s.k);
    const key = `${s.k}|${shown.map((l) => l.key).join(',')}`;
    const now = performance.now();
    if (key === drawnKey && !(terrainChanged && now - drawnAt > STRUCTURES_REFRESH_MS)) return;
    const fixed: Volume[] = [];
    const placed: Volume[] = [];
    shown.forEach((l) => {
      addStructures(fixed, l, s, elevation);
      addVehicles(placed, l, s, 0);
    });
    structures.setData(collection(fixed));
    vehicles.setData(collection(placed));
    drawnKey = key;
    drawnAt = now;
    terrainChanged = false;
    cleared = false;
  }

  // Recalcul une fois la carte posée, jamais pendant le déplacement.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 100);
  };
  const onTerrain = (e: { sourceId?: string; tile?: unknown }) => {
    if (e.sourceId !== 'dem' || !e.tile) return;
    terrainChanged = true;
    clearTimeout(terrainTimer);
    terrainTimer = setTimeout(schedule, STRUCTURES_REFRESH_MS);
  };
  map.on('moveend', schedule);
  map.on('styledata', schedule);
  map.on('sourcedata', onTerrain);
  schedule();

  return {
    stop() {
      clearTimeout(timer);
      clearTimeout(terrainTimer);
      map.off('moveend', schedule);
      map.off('styledata', schedule);
      map.off('sourcedata', onTerrain);
    },
  };
}
