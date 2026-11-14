// Worker des barres rocheuses : calcule les tuiles « rock:// » hors du fil
// principal (voir rockCompute.ts).
//
// Messages reçus : { type: 'tile', id, z, x, y } et { type: 'cancel', id }.
// Réponse : { id, bitmap } (ImageBitmap transférée) ou { id, error }.

import { rockTile } from './rockCompute';

type Msg = { type: 'tile'; id: number; z: number; x: number; y: number } | { type: 'cancel'; id: number };

const running = new Map<number, AbortController>();

self.onmessage = async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    running.get(msg.id)?.abort();
    return;
  }
  const abort = new AbortController();
  running.set(msg.id, abort);
  try {
    const bitmap = await rockTile(msg.z, msg.x, msg.y, abort.signal);
    postMessage({ id: msg.id, bitmap }, { transfer: [bitmap] });
  } catch (err) {
    postMessage({ id: msg.id, error: String(err) });
  } finally {
    running.delete(msg.id);
  }
};
