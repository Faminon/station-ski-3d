// Forêts en sapins 3D sur la carte d'un domaine : chaque arbre est un petit
// volume (tronc et trois étages de branches, pointe enneigée), posé sur le
// relief en « fill-extrusion », comme les remontées.
//
// Économie : on ne plante que les arbres de la vue courante, à partir du zoom
// FOREST_MIN_ZOOM, sur une grille fixe (un arbre par case, légèrement décalé)
// pour qu'ils ne bougent pas quand on se déplace. Les arbres grossissent et
// s'espacent en dézoomant, pour garder la même densité à l'écran. Les pistes,
// les remontées et les routes restent dégagées.

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { METERS_PER_DEG_LAT, metersPerDegLng } from '@/components/station/map3d';

export const FOREST_3D_LAYER = 'forest-3d';
/** En dessous, le motif de sapins au sol suffit ; au-dessus, il s'efface au profit des arbres 3D. */
export const FOREST_MIN_ZOOM = 13.5;
const REF_ZOOM = 15.5;
const MAX_SCALE = 5;
/** Écart moyen entre deux arbres à l'échelle de référence (m). */
const SPACING = 11;
const MAX_TREES = 6000;
/** Cases examinées au plus : au-delà, la grille s'élargit (forêt moins dense, mêmes performances). */
const MAX_CELLS = 45_000;
const REFRESH_MS = 120;

/** Couloirs sans arbres : demi-largeur dégagée de part et d'autre du tracé (m). */
export interface Clearing {
  coordinates: number[][];
  halfWidth: number;
}

type Ring = number[][];
interface Forest {
  rings: Ring[];
  bbox: [number, number, number, number];
}
type Volume = Feature<Polygon, { c: string; b: number; h: number }>;

const TRUNK = '#5b4636';
const GREENS = ['#1f3b2b', '#264532', '#2d503b'];
const SNOW_CAP = '#e4edf1';

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

/** Hexagone de rayon r (m) autour de (lng, lat). */
function hexagon(lng: number, lat: number, r: number, mx: number): Ring {
  const ring: Ring = [];
  for (let a = 0; a < 6; a++) {
    const t = (a / 6) * Math.PI * 2;
    ring.push([lng + (Math.cos(t) * r) / mx, lat + (Math.sin(t) * r) / METERS_PER_DEG_LAT]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * Index des couloirs dégagés, par cases de 60 m : on ne teste que les tronçons
 * proches d'un arbre au lieu de toutes les pistes du domaine.
 */
function clearingIndex(clearings: Clearing[], lng0: number, lat0: number, mx: number) {
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
  return (x: number, y: number): boolean => {
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

export interface ForestController {
  /** Pistes, remontées, routes : couloirs à laisser sans arbres. */
  setClearings(clearings: Clearing[]): void;
  stop(): void;
}

/** Ajoute les sapins 3D des forêts `data` (polygones), sous `beforeId`. */
export function addForestTrees(map: MlMap, data: FeatureCollection, visible: boolean, beforeId?: string): ForestController {
  const forests: Forest[] = [];
  for (const f of data.features) {
    if (f.geometry.type !== 'Polygon') continue;
    const rings = f.geometry.coordinates;
    const lngs = rings[0].map((p) => p[0]);
    const lats = rings[0].map((p) => p[1]);
    forests.push({ rings, bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] });
  }
  // Repère métrique fixe (centre des forêts) : la grille des arbres ne dépend pas de la vue.
  const lng0 = forests.length ? (Math.min(...forests.map((f) => f.bbox[0])) + Math.max(...forests.map((f) => f.bbox[2]))) / 2 : 0;
  const lat0 = forests.length ? (Math.min(...forests.map((f) => f.bbox[1])) + Math.max(...forests.map((f) => f.bbox[3]))) / 2 : 0;
  const mx = metersPerDegLng(lat0);
  let cleared: (x: number, y: number) => boolean = () => false;

  map.addSource(FOREST_3D_LAYER, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, tolerance: 0 });
  map.addLayer(
    {
      id: FOREST_3D_LAYER,
      type: 'fill-extrusion',
      source: FOREST_3D_LAYER,
      minzoom: FOREST_MIN_ZOOM,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'fill-extrusion-color': ['get', 'c'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true,
        // Apparition en douceur, en relais du motif au sol.
        'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], FOREST_MIN_ZOOM, 0, FOREST_MIN_ZOOM + 0.6, 1],
      },
    },
    beforeId,
  );
  const source = map.getSource(FOREST_3D_LAYER) as GeoJSONSource;

  let lastKey = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draw = () => {
    timer = undefined;
    const zoom = map.getZoom();
    const shown = map.getLayer(FOREST_3D_LAYER) && map.getLayoutProperty(FOREST_3D_LAYER, 'visibility') !== 'none';
    if (!shown || zoom < FOREST_MIN_ZOOM || !forests.length) {
      if (lastKey) source.setData({ type: 'FeatureCollection', features: [] });
      lastKey = '';
      return;
    }
    const k = Math.min(MAX_SCALE, Math.max(1, 2 ** (REF_ZOOM - Math.round(zoom * 2) / 2)));
    const kv = Math.sqrt(k);

    // Zone plantée : la vue, limitée autour du centre (au loin, en vue inclinée, les arbres seraient invisibles).
    const b = map.getBounds();
    const c = map.getCenter();
    const reach = 1600 * k;
    const west = Math.max(b.getWest(), c.lng - reach / mx);
    const east = Math.min(b.getEast(), c.lng + reach / mx);
    const south = Math.max(b.getSouth(), c.lat - reach / METERS_PER_DEG_LAT);
    const north = Math.min(b.getNorth(), c.lat + reach / METERS_PER_DEG_LAT);
    let spacing = SPACING * k;
    const area = (east - west) * mx * (north - south) * METERS_PER_DEG_LAT;
    if (area / (spacing * spacing) > MAX_CELLS) spacing = Math.sqrt(area / MAX_CELLS);
    // Grille alignée sur des valeurs rondes : même vue, mêmes arbres.
    spacing = Math.ceil(spacing);

    const i0 = Math.floor(((west - lng0) * mx) / spacing);
    const i1 = Math.ceil(((east - lng0) * mx) / spacing);
    const j0 = Math.floor(((south - lat0) * METERS_PER_DEG_LAT) / spacing);
    const j1 = Math.ceil(((north - lat0) * METERS_PER_DEG_LAT) / spacing);
    const key = `${spacing}|${i0}|${i1}|${j0}|${j1}`;
    if (key === lastKey) return;
    lastKey = key;

    const near = forests.filter((f) => f.bbox[0] <= east && f.bbox[2] >= west && f.bbox[1] <= north && f.bbox[3] >= south);
    const volumes: Volume[] = [];
    let trees = 0;
    // Du centre vers l'extérieur : si le plafond est atteint, ce sont les arbres lointains qui manquent.
    const ci = Math.round(((c.lng - lng0) * mx) / spacing);
    const cj = Math.round(((c.lat - lat0) * METERS_PER_DEG_LAT) / spacing);
    const maxRing = Math.max(ci - i0, i1 - ci, cj - j0, j1 - cj);
    const plant = (i: number, j: number) => {
      if (i < i0 || i > i1 || j < j0 || j > j1) return;
      const r1 = hash(i, j);
      const r2 = hash(j + 7919, i - 104729);
      const x = (i + 0.15 + 0.7 * r1) * spacing;
      const y = (j + 0.15 + 0.7 * r2) * spacing;
      const lng = lng0 + x / mx;
      const lat = lat0 + y / METERS_PER_DEG_LAT;
      if (!near.some((f) => insideForest(lng, lat, f))) return;
      if (cleared(x, y)) return;
      // Sapins de 9 à 16 m, plus ou moins larges.
      const h = (9 + 7 * hash(i * 3 + 1, j * 5 + 2)) * kv;
      const w = (0.85 + 0.3 * r1) * k;
      const green = GREENS[Math.floor(r2 * GREENS.length)];
      const vol = (r: number, base: number, top: number, color: string) =>
        volumes.push({ type: 'Feature', properties: { c: color, b: base, h: top }, geometry: { type: 'Polygon', coordinates: [hexagon(lng, lat, r, mx)] } });
      vol(0.35 * w, 0, 0.22 * h, TRUNK);
      vol(2.6 * w, 0.15 * h, 0.5 * h, green);
      vol(1.9 * w, 0.45 * h, 0.75 * h, green);
      vol(1.1 * w, 0.7 * h, 0.94 * h, green);
      vol(0.55 * w, 0.88 * h, h, SNOW_CAP);
      trees++;
    };
    for (let ring = 0; ring <= maxRing && trees < MAX_TREES; ring++) {
      if (ring === 0) {
        plant(ci, cj);
        continue;
      }
      for (let d = -ring; d <= ring && trees < MAX_TREES; d++) {
        plant(ci + d, cj - ring);
        plant(ci + d, cj + ring);
        if (d !== -ring && d !== ring) {
          plant(ci - ring, cj + d);
          plant(ci + ring, cj + d);
        }
      }
    }
    source.setData({ type: 'FeatureCollection', features: volumes });
  };

  // Recalcul une fois la carte posée (pas à chaque image du déplacement).
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, REFRESH_MS);
  };
  map.on('moveend', schedule);
  map.on('styledata', schedule);
  schedule();

  return {
    setClearings(clearings) {
      cleared = clearingIndex(clearings, lng0, lat0, mx);
      lastKey = '';
      schedule();
    },
    stop() {
      clearTimeout(timer);
      map.off('moveend', schedule);
      map.off('styledata', schedule);
    },
  };
}
