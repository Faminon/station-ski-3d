// Côté carte du worker du relief (terrain.worker.ts) : pentes des tuiles du domaine et
// sapins, calculés à part pendant que la carte s'affiche. Un worker par carte ouverte,
// arrêté avec elle (les calculs en cours sont alors abandonnés).

import type { Clearing } from '@/components/domain/forestPlanting';

/** Par arbre : Mercator x, y relatifs au coin de la tuile du relief, hauteur, largeur, teinte, rang. */
export const TREE_FLOATS = 6;

export interface TerrainWorker {
  /** Pentes par pixel de la tuile (z, x, y) ; `px` : mètres par pixel des altitudes (zoom 14). */
  normals(z: number, x: number, y: number, px: number): Promise<Uint16Array | null>;
  /** Sapins de la tuile, triés par rang (TREE_FLOATS valeurs par arbre). */
  trees(z: number, x: number, y: number): Promise<Float32Array>;
  dispose(): void;
}

type Reply = { id: number; normals?: Uint16Array | null; trees?: Float32Array };

export function startTerrainWorker(dem: { x: number; y: number; alt: Float32Array }[], polygons: number[][][][], clearings: Clearing[]): TerrainWorker | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const pending = new Map<number, (r: Reply) => void>();
  let seq = 0;
  worker.onmessage = (e: MessageEvent<Reply>) => {
    pending.get(e.data.id)?.(e.data);
    pending.delete(e.data.id);
  };
  // Worker hors service : pas de pentes fines ni de sapins, la carte reste utilisable.
  worker.onerror = () => {
    for (const resolve of pending.values()) resolve({ id: -1 });
    pending.clear();
  };
  worker.postMessage({ type: 'init', dem, polygons, clearings });
  const ask = (msg: object) =>
    new Promise<Reply>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      worker.postMessage({ ...msg, id });
    });
  return {
    normals: (z, x, y, px) => ask({ type: 'normals', z, x, y, px }).then((r) => r.normals ?? null),
    trees: (z, x, y) => ask({ type: 'trees', z, x, y }).then((r) => r.trees ?? new Float32Array(0)),
    dispose() {
      worker.terminate();
      pending.clear();
    },
  };
}
