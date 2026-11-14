// Forêts en sapins 3D sur la carte d'un domaine, posées sur le relief en
// « fill-extrusion », comme les remontées.
//
// Les arbres sont servis comme des tuiles vectorielles (protocole trees://),
// fabriquées dans un Web Worker (forestTiles.worker.ts, forestPlanting.ts).
// MapLibre ne demande que les tuiles visibles, les garde en cache et les
// prépare dans ses propres workers : se déplacer ne recalcule que les tuiles
// nouvelles, sans jamais bloquer le fil principal qui dessine la carte.

import { addProtocol, type Map as MlMap, type VectorTileSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { FOREST_PATTERN_LAYER, FOREST_PATTERN_OPACITY } from '@/components/station/map3d';
import { TREES_MAX_TILE_ZOOM, TREES_MIN_TILE_ZOOM, TREES_SOURCE_LAYER, type Clearing } from './forestPlanting';

export type { Clearing } from './forestPlanting';

export const FOREST_3D_LAYER = 'forest-3d';
/** En dessous, le motif de sapins au sol suffit ; au-dessus, il s'efface au profit des arbres 3D. */
export const FOREST_MIN_ZOOM = 13.5;

// ---- Worker et protocole trees://<carte>/<version>/{z}/{x}/{y} -------------------

type Pending = { resolve: (data: ArrayBuffer) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let seq = 0;

function treesWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./forestTiles.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; data?: ArrayBuffer; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.data) p.resolve(e.data.data);
    else p.reject(new Error(e.data.error ?? 'Tuile de sapins indisponible'));
  };
  worker.onerror = () => {
    // Worker hors service : les tuiles en attente échouent, la carte reste utilisable sans sapins 3D.
    for (const p of pending.values()) p.reject(new Error('Worker des sapins indisponible'));
    pending.clear();
  };
  return worker;
}

let registered = false;

function registerTreesProtocol() {
  if (registered) return;
  registered = true;
  addProtocol('trees', (params, abort) => {
    const m = /^trees:\/\/([^/]+)\/\d+\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) return Promise.reject(new Error(`Tuile de sapins invalide : ${params.url}`));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: (data) => resolve({ data }), reject });
      abort.signal.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) return;
          treesWorker().postMessage({ type: 'cancel', id });
          reject(new DOMException('Tuile abandonnée', 'AbortError'));
        },
        { once: true },
      );
      treesWorker().postMessage({ type: 'tile', id, set: m[1], z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) });
    });
  });
}

// ---- Carte ----------------------------------------------------------------------

/** Centre du cadre de la plus grande forêt (en surface de cadre), ou null sans forêt. */
export function largestForestCenter(data: FeatureCollection | null | undefined): [number, number] | null {
  let best: [number, number] | null = null;
  let bestArea = 0;
  for (const f of data?.features ?? []) {
    if (f.geometry.type !== 'Polygon') continue;
    const ring = f.geometry.coordinates[0];
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const [w, e, s, n] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
    const area = (e - w) * (n - s);
    if (area > bestArea) {
      bestArea = area;
      best = [(w + e) / 2, (s + n) / 2];
    }
  }
  return best;
}

export interface ForestController {
  /** Pistes, remontées, routes : couloirs à laisser sans arbres. */
  setClearings(clearings: Clearing[]): void;
  /**
   * Part des sapins 3D dessinés (0 à 1), pour la qualité adaptative. À 0, plus de sapins 3D :
   * le motif de sapins au sol reste affiché à tous les zooms.
   */
  setDensity(density: number): void;
  stop(): void;
}

let mapCounter = 0;

/** Ajoute les sapins 3D des forêts `data` (polygones), sous `beforeId`. */
export function addForestTrees(map: MlMap, data: FeatureCollection, visible: boolean, beforeId?: string): ForestController {
  registerTreesProtocol();
  const set = `carte${++mapCounter}`;
  let version = 0;
  const tilesUrl = () => `trees://${set}/${version}/{z}/{x}/{y}`;

  const polygons = data.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : []));
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const rings of polygons) {
    for (const [lng, lat] of rings[0]) {
      w = Math.min(w, lng);
      e = Math.max(e, lng);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  }
  treesWorker().postMessage({ type: 'forests', set, polygons });

  map.addSource(FOREST_3D_LAYER, {
    type: 'vector',
    tiles: [tilesUrl()],
    minzoom: TREES_MIN_TILE_ZOOM,
    maxzoom: TREES_MAX_TILE_ZOOM,
    // Aucune tuile demandée hors des forêts.
    ...(polygons.length ? { bounds: [w, s, e, n] as [number, number, number, number] } : {}),
  });
  map.addLayer(
    {
      id: FOREST_3D_LAYER,
      type: 'fill-extrusion',
      source: FOREST_3D_LAYER,
      'source-layer': TREES_SOURCE_LAYER,
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

  return {
    setClearings(clearings) {
      treesWorker().postMessage({ type: 'clearings', set, clearings });
      // Nouvelle adresse : MapLibre oublie les tuiles déjà plantées et les redemande.
      version++;
      (map.getSource(FOREST_3D_LAYER) as VectorTileSource | undefined)?.setTiles([tilesUrl()]);
    },
    setDensity(density) {
      if (!map.getLayer(FOREST_3D_LAYER)) return;
      // Chaque arbre porte un rang r (0 à 0,95) : on garde ceux sous la densité voulue.
      map.setFilter(FOREST_3D_LAYER, density >= 1 ? null : ['<', ['get', 'r'], density]);
      if (map.getLayer(FOREST_PATTERN_LAYER)) {
        map.setPaintProperty(FOREST_PATTERN_LAYER, 'fill-opacity', density > 0 ? FOREST_PATTERN_OPACITY : 0.95);
      }
    },
    stop() {
      treesWorker().postMessage({ type: 'drop', set });
    },
  };
}
