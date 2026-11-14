// Forêts en sapins 3D sur la carte d'un domaine.
//
// Les arbres sont plantés dans un Web Worker (forestTiles.worker.ts,
// forestPlanting.ts), tuile par tuile, sans jamais bloquer le fil principal
// qui dessine la carte. Deux rendus :
// - par défaut, un calque WebGL qui répète un seul modèle de sapin
//   (forestInstanced.ts) : beaucoup moins de travail pour la carte graphique ;
// - en repli (navigateur sans WebGL 2 ou sans textures de nombres décimaux, ou
//   `?sapins=volumes` dans l'adresse), des volumes « fill-extrusion » servis
//   comme tuiles vectorielles (protocole trees://), posés sur le relief par
//   MapLibre.

import { addProtocol, type Map as MlMap, type VectorTileSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { FOREST_PATTERN_LAYER, FOREST_PATTERN_OPACITY } from '@/components/station/map3d';
import { TREES_MAX_TILE_ZOOM, TREES_MIN_TILE_ZOOM, TREES_SOURCE_LAYER, type Clearing } from './forestPlanting';
import { createInstancedForestLayer, supportsInstancedForest, type TreeTileData } from './forestInstanced';

export type { Clearing } from './forestPlanting';

export const FOREST_3D_LAYER = 'forest-3d';
/** En dessous, le motif de sapins au sol suffit ; au-dessus, il s'efface au profit des arbres 3D. */
export const FOREST_MIN_ZOOM = 13.5;

// ---- Worker ---------------------------------------------------------------------

type Reply = { id: number; data?: ArrayBuffer | Float32Array; ranks?: Float32Array; error?: string };
type Pending = { resolve: (reply: Reply) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let seq = 0;

function treesWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./forestTiles.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.data) p.resolve(e.data);
    else p.reject(new Error(e.data.error ?? 'Tuile de sapins indisponible'));
  };
  worker.onerror = () => {
    // Worker hors service : les tuiles en attente échouent, la carte reste utilisable sans sapins 3D.
    for (const p of pending.values()) p.reject(new Error('Worker des sapins indisponible'));
    pending.clear();
  };
  return worker;
}

/** Demande au worker une tuile d'arbres (`tile` : tuile vectorielle, `instances` : liste d'arbres). */
function askWorker(type: 'tile' | 'instances', set: string, z: number, x: number, y: number, signal: AbortSignal): Promise<Reply> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    signal.addEventListener(
      'abort',
      () => {
        if (!pending.delete(id)) return;
        treesWorker().postMessage({ type: 'cancel', id });
        reject(new DOMException('Tuile abandonnée', 'AbortError'));
      },
      { once: true },
    );
    treesWorker().postMessage({ type, id, set, z, x, y });
  });
}

// ---- Rendu de repli : protocole trees://<carte>/<version>/{z}/{x}/{y} ---------------

let registered = false;

function registerTreesProtocol() {
  if (registered) return;
  registered = true;
  addProtocol('trees', async (params, abort) => {
    const m = /^trees:\/\/([^/]+)\/\d+\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`Tuile de sapins invalide : ${params.url}`);
    const reply = await askWorker('tile', m[1], Number(m[2]), Number(m[3]), Number(m[4]), abort.signal);
    return { data: reply.data as ArrayBuffer };
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
  const set = `carte${++mapCounter}`;
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

  // Motif au sol : visible partout quand il n'y a plus de sapins 3D (densité nulle).
  const syncPattern = (density: number) => {
    if (map.getLayer(FOREST_PATTERN_LAYER)) map.setPaintProperty(FOREST_PATTERN_LAYER, 'fill-opacity', density > 0 ? FOREST_PATTERN_OPACITY : 0.95);
  };
  const stopWorker = () => treesWorker().postMessage({ type: 'drop', set });
  const forced = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('sapins') === 'volumes';

  if (!forced && polygons.length && supportsInstancedForest(map)) {
    const layer = createInstancedForestLayer({
      id: FOREST_3D_LAYER,
      map,
      bounds: [w, s, e, n],
      request: async (z, x, y, signal): Promise<TreeTileData> => {
        const reply = await askWorker('instances', set, z, x, y, signal);
        return { data: reply.data as Float32Array, ranks: reply.ranks ?? new Float32Array(0) };
      },
    });
    map.addLayer(layer, beforeId);
    // Suit l'interrupteur de la neige, comme les autres calques d'hiver (map3d.ts, applyWinter).
    if (!visible) map.setLayoutProperty(FOREST_3D_LAYER, 'visibility', 'none');
    return {
      setClearings(clearings) {
        treesWorker().postMessage({ type: 'clearings', set, clearings });
        layer.reset();
      },
      setDensity(density) {
        layer.setDensity(density);
        syncPattern(density);
      },
      stop: stopWorker,
    };
  }

  registerTreesProtocol();
  let version = 0;
  const tilesUrl = () => `trees://${set}/${version}/{z}/{x}/{y}`;
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
      syncPattern(density);
    },
    stop: stopWorker,
  };
}
