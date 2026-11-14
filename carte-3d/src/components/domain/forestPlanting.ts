// Plantation des sapins 3D, tuile par tuile (exécutée dans forestTiles.worker.ts).
//
// Chaque arbre est un petit volume (étages de branches, pointe enneigée)
// extrudé sur le relief par MapLibre. Les arbres sont posés sur une grille fixe
// (un arbre par case, légèrement décalé) : une même case donne toujours le même
// arbre, d'une tuile à l'autre et d'une visite à l'autre. Plus la tuile est
// lointaine (zoom faible), plus les arbres sont grands et espacés, pour garder
// la même densité à l'écran. Les pistes, remontées et routes restent dégagées.

import { MVT_EXTENT, MvtLayer, encodeTile } from './mvt';

export const TREES_SOURCE_LAYER = 'trees';
/** Zooms des tuiles de sapins : en deçà, le motif au sol ; au-delà, MapLibre agrandit la tuile 16. */
export const TREES_MIN_TILE_ZOOM = 13;
export const TREES_MAX_TILE_ZOOM = 16;

const METERS_PER_DEG_LAT = 110_574;
const metersPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
const EARTH_CIRCUMFERENCE = 40_075_016.686;

/** Écart moyen entre deux arbres au plus près (m). */
const SPACING = 11;
const MAX_SCALE = 5;

export const GREENS = ['#1f3b2b', '#264532', '#2d503b'];
export const SNOW_CAP = '#e4edf1';

type Ring = number[][];
interface Forest {
  rings: Ring[];
  bbox: [number, number, number, number];
}

/** Couloirs sans arbres : demi-largeur dégagée de part et d'autre du tracé (m). */
export interface Clearing {
  coordinates: number[][];
  halfWidth: number;
}

export interface ForestSet {
  forests: Forest[];
  bbox: [number, number, number, number];
  /** Repère métrique fixe (centre des forêts) : la grille ne dépend ni de la vue ni de la tuile. */
  lng0: number;
  lat0: number;
  mx: number;
  cleared: (x: number, y: number) => boolean;
}

function hash(i: number, j: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

function insideRing(x: number, y: number, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Dans la forêt (contour extérieur) et hors de ses clairières (anneaux intérieurs). */
function insideForest(lng: number, lat: number, f: Forest): boolean {
  if (lng < f.bbox[0] || lng > f.bbox[2] || lat < f.bbox[1] || lat > f.bbox[3]) return false;
  if (!insideRing(lng, lat, f.rings[0])) return false;
  for (let i = 1; i < f.rings.length; i++) if (insideRing(lng, lat, f.rings[i])) return false;
  return true;
}

/** Forêts (polygones GeoJSON : anneaux de [lng, lat]) prêtes à planter. */
export function buildForestSet(polygons: Ring[][]): ForestSet {
  const forests: Forest[] = polygons.map((rings) => {
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of rings[0]) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    return { rings, bbox: [w, s, e, n] };
  });
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of forests) {
    bbox[0] = Math.min(bbox[0], f.bbox[0]);
    bbox[1] = Math.min(bbox[1], f.bbox[1]);
    bbox[2] = Math.max(bbox[2], f.bbox[2]);
    bbox[3] = Math.max(bbox[3], f.bbox[3]);
  }
  const lng0 = forests.length ? (bbox[0] + bbox[2]) / 2 : 0;
  const lat0 = forests.length ? (bbox[1] + bbox[3]) / 2 : 0;
  return { forests, bbox, lng0, lat0, mx: metersPerDegLng(lat0), cleared: () => false };
}

/**
 * Index des couloirs dégagés, par cases de 60 m : on ne teste que les tronçons
 * proches d'un arbre au lieu de toutes les pistes du domaine.
 */
export function setClearings(set: ForestSet, clearings: Clearing[]) {
  const { lng0, lat0, mx } = set;
  const CELL = 60;
  const cells = new Map<string, { ax: number; ay: number; bx: number; by: number; w: number }[]>();
  const toXY = ([lng, lat]: number[]) => [(lng - lng0) * mx, (lat - lat0) * METERS_PER_DEG_LAT];
  for (const c of clearings) {
    for (let i = 1; i < c.coordinates.length; i++) {
      const [ax, ay] = toXY(c.coordinates[i - 1]);
      const [bx, by] = toXY(c.coordinates[i]);
      const seg = { ax, ay, bx, by, w: c.halfWidth };
      const pad = c.halfWidth;
      for (let cx = Math.floor((Math.min(ax, bx) - pad) / CELL); cx <= Math.floor((Math.max(ax, bx) + pad) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - pad) / CELL); cy <= Math.floor((Math.max(ay, by) + pad) / CELL); cy++) {
          const key = `${cx}|${cy}`;
          const list = cells.get(key);
          if (list) list.push(seg);
          else cells.set(key, [seg]);
        }
      }
    }
  }
  set.cleared = (x, y) => {
    const list = cells.get(`${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`);
    if (!list) return false;
    for (const s of list) {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
      if (Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy)) < s.w) return true;
    }
    return false;
  };
}

const tileLng = (x: number, n: number) => (x / n) * 360 - 180;
const tileLat = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** Hexagones des six angles, calculés une fois (sens horaire à l'écran, y vers le bas). */
const HEX = Array.from({ length: 6 }, (_, a) => [Math.cos((a / 6) * Math.PI * 2), Math.sin((a / 6) * Math.PI * 2)]);

/** Un sapin planté : pied, hauteur et largeur (m), teinte (indice dans GREENS), rang (0 à 0,95). */
interface Tree {
  lng: number;
  lat: number;
  h: number;
  w: number;
  green: number;
  rank: number;
}

/** Bornes géographiques de la tuile (z, x, y). */
function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z;
  return { n, west: tileLng(x, n), east: tileLng(x + 1, n), north: tileLat(y, n), south: tileLat(y + 1, n) };
}

/** Plante les sapins de la tuile (z, x, y) ; rien hors des forêts. */
function forEachTree(set: ForestSet, z: number, x: number, y: number, plant: (tree: Tree) => void) {
  const { west, east, north, south } = tileBounds(z, x, y);
  const [bw, bs, be, bn] = set.bbox;
  if (east < bw || west > be || north < bs || south > bn) return;
  const near = set.forests.filter((f) => f.bbox[0] <= east && f.bbox[2] >= west && f.bbox[1] <= north && f.bbox[3] >= south);
  if (!near.length) return;

  // Espacement doublé à chaque niveau de zoom en moins (11 m en tuile 16, ~17 m en 15, ~34 m en 14,
  // ~67 m en 13) : environ 2 500 cases par tuile au plus, quel que soit le zoom. Les arbres
  // grandissent avec l'espacement, dans la limite de MAX_SCALE.
  const spacing = Math.ceil(Math.max(SPACING, SPACING * 2 ** (15.6 - z)));
  const k = Math.min(MAX_SCALE, spacing / SPACING);
  const kv = Math.sqrt(k);
  const { lng0, lat0, mx } = set;

  // Cases dont l'arbre peut tomber dans la tuile ; chaque arbre appartient à la seule tuile qui contient son pied.
  const i0 = Math.floor(((west - lng0) * mx) / spacing) - 1;
  const i1 = Math.floor(((east - lng0) * mx) / spacing);
  const j0 = Math.floor(((south - lat0) * METERS_PER_DEG_LAT) / spacing) - 1;
  const j1 = Math.floor(((north - lat0) * METERS_PER_DEG_LAT) / spacing);

  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const r1 = hash(i, j);
      const r2 = hash(j + 7919, i - 104729);
      const px = (i + 0.15 + 0.7 * r1) * spacing;
      const py = (j + 0.15 + 0.7 * r2) * spacing;
      const lng = lng0 + px / mx;
      const lat = lat0 + py / METERS_PER_DEG_LAT;
      if (lng < west || lng >= east || lat < south || lat >= north) continue;
      if (!near.some((f) => insideForest(lng, lat, f))) continue;
      if (set.cleared(px, py)) continue;
      plant({
        lng,
        lat,
        // Sapins de 9 à 16 m, plus ou moins larges.
        h: (9 + 7 * hash(i * 3 + 1, j * 5 + 2)) * kv,
        w: (0.85 + 0.3 * r1) * k,
        green: Math.floor(r2 * GREENS.length),
        // Rang (0 à 0,95, par pas de 0,05) : la qualité adaptative éclaircit la forêt en ne gardant
        // que les arbres de rang inférieur à la densité voulue, sans refabriquer les tuiles.
        rank: Math.floor(hash(i * 7 + 3, j * 11 + 5) * 20) / 20,
      });
    }
  }
}

const mercatorX = (lng: number) => (lng + 180) / 360;
const mercatorY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

/** Valeurs par sapin dans `plantTileInstances` : décalage mercator (x, y), hauteur, largeur, teinte. */
export const TREE_INSTANCE_FLOATS = 5;

/**
 * Sapins de la tuile (z, x, y) pour le calque instancié (forestInstanced.ts) : par arbre, décalage
 * en coordonnées mercator depuis le coin nord-ouest de la tuile, hauteur et largeur (m) et teinte.
 * Les arbres sont triés par rang : les `n` premiers sont ceux de rang inférieur à une densité donnée
 * (`ranks` permet de trouver `n`).
 */
export function plantTileInstances(set: ForestSet, z: number, x: number, y: number): { data: Float32Array; ranks: Float32Array } {
  const trees: Tree[] = [];
  forEachTree(set, z, x, y, (tree) => trees.push(tree));
  trees.sort((a, b) => a.rank - b.rank);
  const n = 2 ** z;
  const data = new Float32Array(trees.length * TREE_INSTANCE_FLOATS);
  const ranks = new Float32Array(trees.length);
  trees.forEach((t, i) => {
    const o = i * TREE_INSTANCE_FLOATS;
    // Décalages calculés en double précision, puis petits : la précision des flottants simples suffit.
    data[o] = mercatorX(t.lng) - x / n;
    data[o + 1] = mercatorY(t.lat) - y / n;
    data[o + 2] = t.h;
    data[o + 3] = t.w;
    data[o + 4] = t.green;
    ranks[i] = t.rank;
  });
  return { data, ranks };
}

/** Tuile vectorielle des sapins (z, x, y), vide hors des forêts : rendu de repli en « fill-extrusion ». */
export function plantTile(set: ForestSet, z: number, x: number, y: number): ArrayBuffer {
  const layer = new MvtLayer(TREES_SOURCE_LAYER);
  const { n, north, south } = tileBounds(z, x, y);
  // Tuiles lointaines : arbres simplifiés, à peine différents vus de loin.
  const detailed = z >= 15;
  // Mercator : même échelle sur les deux axes, prise au centre de la tuile.
  const midLat = (north + south) / 2;
  const unitsPerMeter = (MVT_EXTENT * n) / (EARTH_CIRCUMFERENCE * Math.cos((midLat * Math.PI) / 180));

  forEachTree(set, z, x, y, ({ lng, lat, h, w, green: greenIndex, rank }) => {
    const green = GREENS[greenIndex];
    const tx = (mercatorX(lng) * n - x) * MVT_EXTENT;
    const ty = (mercatorY(lat) * n - y) * MVT_EXTENT;
    const vol = (r: number, base: number, top: number, color: string) => {
      const ru = r * unitsPerMeter;
      const ring: number[] = [];
      for (const [c, s] of HEX) ring.push(tx + c * ru, ty + s * ru);
      layer.addPolygon(ring, { c: color, b: Math.round(base * 10) / 10, h: Math.round(top * 10) / 10, r: rank });
    };
    // La carte graphique dessine ~16 triangles par volume : pas de tronc (caché sous les branches
    // dès que la vue est inclinée). De près, trois étages en cône et une pointe enneigée ; au loin,
    // deux étages suffisent.
    if (detailed) {
      vol(2.6 * w, 0.06 * h, 0.5 * h, green);
      vol(1.9 * w, 0.45 * h, 0.75 * h, green);
      vol(1.1 * w, 0.7 * h, 0.94 * h, green);
      vol(0.55 * w, 0.88 * h, h, SNOW_CAP);
    } else {
      vol(2.4 * w, 0.08 * h, 0.6 * h, green);
      vol(1.4 * w, 0.55 * h, 0.92 * h, green);
      vol(0.55 * w, 0.86 * h, h, SNOW_CAP);
    }
  });
  return encodeTile([layer]);
}
