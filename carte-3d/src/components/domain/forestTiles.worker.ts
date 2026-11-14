// Worker des sapins 3D : plante les arbres des forêts hors du fil principal, qui
// reste libre pour dessiner la carte.
//
// Messages reçus :
//   { type: 'forests', set, polygons }      forêts d'une carte (remplace les précédentes)
//   { type: 'clearings', set, clearings }   couloirs à laisser sans arbres
//   { type: 'tile', id, set, z, x, y }      tuile vectorielle (rendu de repli en « fill-extrusion »)
//   { type: 'instances', id, set, z, x, y } liste d'arbres de la tuile (calque instancié)
//   { type: 'cancel', id }                  demande devenue inutile (vue déjà ailleurs)
//   { type: 'drop', set }                   carte fermée
// Réponses : { id, data: ArrayBuffer } pour une tuile vectorielle,
//            { id, data: Float32Array, ranks: Float32Array } pour une liste d'arbres (transférées),
//            { id, error } en cas d'échec.

import { buildForestSet, plantTile, plantTileInstances, setClearings, type Clearing, type ForestSet } from './forestPlanting';

type Job = { type: 'tile' | 'instances'; id: number; set: string; z: number; x: number; y: number };
type Msg =
  | { type: 'forests'; set: string; polygons: number[][][][] }
  | { type: 'clearings'; set: string; clearings: Clearing[] }
  | Job
  | { type: 'cancel'; id: number }
  | { type: 'drop'; set: string };

const sets = new Map<string, ForestSet>();
const queue: Job[] = [];
let scheduled = false;

/** Une demande par tour de boucle : une annulation arrivée entre-temps est prise en compte. */
function work() {
  scheduled = false;
  const job = queue.shift();
  if (!job) return;
  const set = sets.get(job.set);
  try {
    if (job.type === 'instances') {
      const { data, ranks } = set ? plantTileInstances(set, job.z, job.x, job.y) : { data: new Float32Array(0), ranks: new Float32Array(0) };
      postMessage({ id: job.id, data, ranks }, { transfer: [data.buffer, ranks.buffer] });
    } else {
      const data = set ? plantTile(set, job.z, job.x, job.y) : new ArrayBuffer(0);
      postMessage({ id: job.id, data }, { transfer: [data] });
    }
  } catch (e) {
    postMessage({ id: job.id, error: String(e) });
  }
  schedule();
}

function schedule() {
  if (scheduled || !queue.length) return;
  scheduled = true;
  setTimeout(work, 0);
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'forests':
      sets.set(msg.set, buildForestSet(msg.polygons));
      break;
    case 'clearings': {
      const set = sets.get(msg.set);
      if (set) setClearings(set, msg.clearings);
      break;
    }
    case 'tile':
    case 'instances':
      queue.push(msg);
      schedule();
      break;
    case 'cancel': {
      const i = queue.findIndex((j) => j.id === msg.id);
      if (i >= 0) queue.splice(i, 1);
      break;
    }
    case 'drop':
      sets.delete(msg.set);
      break;
  }
};
