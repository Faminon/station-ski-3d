// Worker de la carte Three.js : les deux gros calculs du relief, hors du fil principal qui
// reste libre pour afficher la carte (et l'écran de chargement) sans à-coups.
//
// - Pentes par pixel des tuiles du domaine (texture de normales, voir terrain.ts).
// - Plantation des sapins d'une tuile du relief (voir forest.ts), plusieurs secondes en tout :
//   la carte est montrée avant, les forêts poussent ensuite tuile par tuile.
//
// Messages reçus :
//   { type: 'init', dem: { x, y, alt }[], polygons, clearings }   altitudes (tuiles 14) et forêts
//   { type: 'normals', id, z, x, y, px }                         pentes d'une tuile (px : m par pixel)
//   { type: 'trees', id, z, x, y }                               sapins d'une tuile
// Réponses (tableaux transférés) :
//   { id, normals: Uint16Array | null }                          dh/dx, dh/dz en demi-flottants (RG)
//   { id, trees: Float32Array, count }                           TREE_FLOATS valeurs par arbre, triés par rang
// Les pentes passent avant les sapins : la carte en a besoin pour s'afficher.

import { buildForestSet, plantTileInstances, setClearings, TREE_INSTANCE_FLOATS, type Clearing, type ForestSet } from '@/components/domain/forestPlanting';
import { TREE_FLOATS } from './terrainWorker';

/** Zoom des altitudes du domaine : les normales par pixel en sont tirées (~7 m par pixel). */
const DEM_ZOOM = 14;
const SIZE = 256;
/** Relief accentué de 20 % (geo.ts). */
const EXAGGERATION = 1.2;
/** Flou des altitudes avant le calcul des pentes : rayon (pixels de ~7 m) et noyau gaussien (σ = 1,5 px). */
const BLUR_RADIUS = 4;
const BLUR_KERNEL = Array.from({ length: 2 * BLUR_RADIUS + 1 }, (_, i) => Math.exp(-((i - BLUR_RADIUS) ** 2) / (2 * 1.5 ** 2)));
/** Zoom des tuiles de plantation : un arbre tous les ~17 m. */
const PLANT_ZOOM = 15;

type Msg =
  | { type: 'init'; dem: { x: number; y: number; alt: Float32Array }[]; polygons: number[][][][]; clearings: Clearing[] }
  | { type: 'normals'; id: number; z: number; x: number; y: number; px: number }
  | { type: 'trees'; id: number; z: number; x: number; y: number };

const dem = new Map<number, Float32Array>();
const demKey = (x: number, y: number) => x * 4_194_304 + y;
let forests: ForestSet | null = null;
const urgent: Msg[] = [];
const later: Msg[] = [];
let scheduled = false;

// ---- Pentes ------------------------------------------------------------------------------------

/** Conversion d'un flottant en demi-flottant (IEEE 754, arrondi au plus proche). */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = (mant | 0x800000) >> (1 - exp);
    return sign | ((m + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >> 13);
}

function normals(z: number, x: number, y: number, px: number): Uint16Array | null {
  if (z > DEM_ZOOM) return null;
  const per = 2 ** (DEM_ZOOM - z);
  const N = SIZE * per;
  // Altitudes de la tuile et d'une bordure (tuiles voisines) assez large pour le flou, relief exagéré.
  const B = BLUR_RADIUS + 1;
  const W = N + 2 * B;
  const H = new Float32Array(W * W).fill(NaN);
  let any = false;
  const gx0 = x * N - B;
  const gy0 = y * N - B;
  // Tuile par tuile (et non pixel par pixel) : quelques recherches au lieu de centaines de milliers.
  for (let ty = Math.floor(gy0 / SIZE); ty <= Math.floor((gy0 + W - 1) / SIZE); ty++) {
    for (let tx = Math.floor(gx0 / SIZE); tx <= Math.floor((gx0 + W - 1) / SIZE); tx++) {
      const t = dem.get(demKey(tx, ty));
      if (!t) continue;
      any = true;
      const j0 = Math.max(0, ty * SIZE - gy0);
      const j1 = Math.min(W, (ty + 1) * SIZE - gy0);
      const i0 = Math.max(0, tx * SIZE - gx0);
      const i1 = Math.min(W, (tx + 1) * SIZE - gx0);
      for (let j = j0; j < j1; j++) {
        const row = (gy0 + j - ty * SIZE) * SIZE - tx * SIZE + gx0;
        for (let i = i0; i < i1; i++) H[j * W + i] = t[row + i] * EXAGGERATION;
      }
    }
  }
  if (!any) return null;
  // Pixels sans tuile (bord de la zone chargée) : la valeur voisine sur la ligne, puis la colonne.
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!Number.isNaN(H[k])) continue;
        const left = pass === 0 ? (i > 0 ? H[k - 1] : NaN) : j > 0 ? H[k - W] : NaN;
        if (!Number.isNaN(left)) H[k] = left;
      }
      for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i;
        if (!Number.isNaN(H[k])) continue;
        const right = pass === 0 ? (i < W - 1 ? H[k + 1] : NaN) : j < W - 1 ? H[k + W] : NaN;
        if (!Number.isNaN(right)) H[k] = right;
      }
    }
  }
  // Flou gaussien séparable (lignes, puis colonnes).
  const R = BLUR_RADIUS;
  const blur = (src: Float32Array, step: number): Float32Array => {
    const out = new Float32Array(W * W);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const pos = step === 1 ? i : j;
        let sum = 0;
        let wsum = 0;
        for (let d = -R; d <= R; d++) {
          const q = Math.min(W - 1, Math.max(0, pos + d));
          const v = src[step === 1 ? j * W + q : q * W + i];
          if (Number.isNaN(v)) continue;
          sum += v * BLUR_KERNEL[d + R];
          wsum += BLUR_KERNEL[d + R];
        }
        out[j * W + i] = wsum ? sum / wsum : NaN;
      }
    }
    return out;
  };
  const S = blur(blur(H, 1), W);
  const data = new Uint16Array(N * N * 2);
  const h = (i: number, j: number, fallback: number) => {
    const v = S[j * W + i];
    return Number.isNaN(v) ? fallback : v;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = h(i + B, j + B, 0);
      const dx = (h(i + B + 1, j + B, c) - h(i + B - 1, j + B, c)) / (2 * px);
      const dz = (h(i + B, j + B + 1, c) - h(i + B, j + B - 1, c)) / (2 * px);
      const o = (j * N + i) * 2;
      data[o] = toHalf(dx);
      data[o + 1] = toHalf(dz);
    }
  }
  return data;
}

// ---- Sapins ------------------------------------------------------------------------------------

function trees(z: number, x: number, y: number): { trees: Float32Array; count: number } {
  const per = 2 ** (PLANT_ZOOM - z);
  const parts: { data: Float32Array; ranks: Float32Array; i: number; j: number }[] = [];
  let count = 0;
  if (forests) {
    for (let i = 0; i < per; i++) {
      for (let j = 0; j < per; j++) {
        const { data, ranks } = plantTileInstances(forests, PLANT_ZOOM, x * per + i, y * per + j);
        if (!ranks.length) continue;
        parts.push({ data, ranks, i, j });
        count += ranks.length;
      }
    }
  }
  // Positions ramenées au coin de la tuile du relief, puis tri par rang (dessin partiel au loin).
  const n = 2 ** PLANT_ZOOM;
  const order: { p: number; t: number; rank: number }[] = [];
  parts.forEach((part, p) => part.ranks.forEach((rank, t) => order.push({ p, t, rank })));
  order.sort((a, b) => a.rank - b.rank);
  const out = new Float32Array(count * TREE_FLOATS);
  order.forEach(({ p, t, rank }, k) => {
    const { data, i, j } = parts[p];
    const o = t * TREE_INSTANCE_FLOATS;
    const q = k * TREE_FLOATS;
    out[q] = data[o] + i / n;
    out[q + 1] = data[o + 1] + j / n;
    out[q + 2] = data[o + 2];
    out[q + 3] = data[o + 3];
    out[q + 4] = data[o + 4];
    out[q + 5] = rank;
  });
  return { trees: out, count };
}

// ---- File d'attente ------------------------------------------------------------------------------

function work() {
  scheduled = false;
  const msg = urgent.shift() ?? later.shift();
  if (!msg) return;
  if (msg.type === 'normals') {
    const data = normals(msg.z, msg.x, msg.y, msg.px);
    postMessage({ id: msg.id, normals: data }, { transfer: data ? [data.buffer] : [] });
  } else if (msg.type === 'trees') {
    const out = trees(msg.z, msg.x, msg.y);
    postMessage({ id: msg.id, ...out }, { transfer: [out.trees.buffer] });
  }
  schedule();
}

function schedule() {
  if (scheduled || (!urgent.length && !later.length)) return;
  scheduled = true;
  setTimeout(work, 0);
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    for (const t of msg.dem) dem.set(demKey(t.x, t.y), t.alt);
    forests = buildForestSet(msg.polygons);
    setClearings(forests, msg.clearings);
    return;
  }
  (msg.type === 'normals' ? urgent : later).push(msg);
  schedule();
};
