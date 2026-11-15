// Protocole « rock://z/x/y » des barres rocheuses sur la carte enneigée.
//
// Les tuiles sont calculées dans un Web Worker (rock.worker.ts, rockCompute.ts) :
// pentes, décodage des images et recoloration de la photo aérienne ne bloquent
// plus le fil principal qui dessine la carte. Sans worker (navigateur ancien ou
// worker en panne), le calcul se replie sur le fil principal, comme avant.

import { addProtocol } from 'maplibre-gl';
import { offlinePack } from '@/lib/offlinePack';

type Pending = { resolve: (bitmap: ImageBitmap) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let workerBroken = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined';
let seq = 0;

function rockWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./rock.worker.ts', import.meta.url), { type: 'module' });
    // Appli mobile : le worker lit lui aussi les tuiles du paquet hors ligne.
    const pack = offlinePack();
    if (pack) worker.postMessage({ type: 'pack', pack });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) {
      e.data.bitmap?.close();
      return;
    }
    pending.delete(e.data.id);
    if (e.data.bitmap) p.resolve(e.data.bitmap);
    else p.reject(new Error(e.data.error ?? 'Tuile de roche indisponible'));
  };
  worker.onerror = () => {
    // Worker hors service : les tuiles suivantes sont calculées sur le fil principal.
    workerBroken = true;
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(new Error('Worker de la roche indisponible'));
    pending.clear();
  };
  return worker;
}

/** Calcul de repli, sur le fil principal (module chargé seulement s'il sert). */
async function rockTileHere(z: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap> {
  const { rockTile } = await import('./rockCompute');
  return rockTile(z, x, y, signal);
}

function rockTileInWorker(w: Worker, z: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    signal.addEventListener(
      'abort',
      () => {
        if (!pending.delete(id)) return;
        w.postMessage({ type: 'cancel', id });
        reject(new DOMException('Tuile abandonnée', 'AbortError'));
      },
      { once: true },
    );
    w.postMessage({ type: 'tile', id, z, x, y });
  });
}

let registered = false;

/** Protocole « rock:// » des tuiles de roche (une seule fois par page). */
export function registerRockProtocol() {
  if (registered) return;
  registered = true;
  addProtocol('rock', async (params, abortController) => {
    const [z, x, y] = params.url.replace('rock://', '').split('/').map(Number);
    const w = rockWorker();
    const data = w ? await rockTileInWorker(w, z, x, y, abortController.signal) : await rockTileHere(z, x, y, abortController.signal);
    return { data };
  });
}
