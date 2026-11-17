// Altitudes du domaine pour la carte Three.js : tuiles « terrarium » (Terrain Tiles,
// paquet hors ligne compris, voir src/lib/offlinePack.ts) décodées une fois, puis lues
// par interpolation bilinéaire. Deux niveaux : fin sur le domaine (zoom 14, ~7 m par
// pixel), grossier autour (zoom 11) pour l'horizon.

import { fetchTile } from '@/lib/offlinePack';
import type { Frame } from './geo';

const SIZE = 256;

interface Level {
  zoom: number;
  /** Tuiles par clé numérique (voir `key`) : lues des milliers de fois par image (véhicules animés). */
  tiles: Map<number, Float32Array>;
}

/** Clé d'une tuile (x, y) : un nombre plutôt qu'une chaîne, bien plus rapide à chaque lecture. */
const key = (x: number, y: number) => x * 4_194_304 + y;

export interface Elevation {
  /** Altitude réelle (m) au point (x, z) du repère, ou null hors des tuiles chargées. */
  at(x: number, z: number): number | null;
  /** Comme `at`, 0 hors des tuiles (bords de l'horizon). */
  atOr0(x: number, z: number): number;
  /** Altitudes brutes (256 × 256, m) d'une tuile chargée, ou null. */
  tile(zoom: number, x: number, y: number): Float32Array | null;
}

async function decode(z: number, x: number, y: number): Promise<Float32Array | null> {
  try {
    const bitmap = await createImageBitmap(await fetchTile('dem', z, x, y));
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const alt = new Float32Array(SIZE * SIZE);
    // Terrarium : altitude = R × 256 + V + B / 256 − 32 768.
    for (let i = 0; i < SIZE * SIZE; i++) alt[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    return alt;
  } catch {
    return null;
  }
}

/** Charge les tuiles d'altitude (z, x, y) demandées, puis renvoie le lecteur d'altitude. */
export async function loadElevation(frame: Frame, levels: { zoom: number; tiles: [number, number][] }[], onTile?: () => void): Promise<Elevation> {
  const loaded: Level[] = await Promise.all(
    levels.map(async ({ zoom, tiles }) => {
      const map = new Map<number, Float32Array>();
      await Promise.all(
        tiles.map(async ([x, y]) => {
          const alt = await decode(zoom, x, y);
          if (alt) map.set(key(x, y), alt);
          onTile?.();
        }),
      );
      return { zoom, tiles: map };
    }),
  );
  // Du plus fin au plus grossier.
  loaded.sort((a, b) => b.zoom - a.zoom);

  const sample = (level: Level, mx: number, my: number): number | null => {
    const n = 2 ** level.zoom;
    const fx = mx * n;
    const fy = my * n;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const tile = level.tiles.get(key(tx, ty));
    if (!tile) return null;
    // Pixel dans la tuile ; aux bords, la tuile voisine fournit le pixel suivant.
    const px = (fx - tx) * SIZE - 0.5;
    const py = (fy - ty) * SIZE - 0.5;
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const dx = px - ix;
    const dy = py - iy;
    const read = (i: number, j: number): number => {
      if (i >= 0 && j >= 0 && i < SIZE && j < SIZE) return tile[j * SIZE + i];
      const nx = tx + Math.floor(i / SIZE);
      const ny = ty + Math.floor(j / SIZE);
      const other = level.tiles.get(key(nx, ny));
      const ci = ((i % SIZE) + SIZE) % SIZE;
      const cj = ((j % SIZE) + SIZE) % SIZE;
      return other ? other[cj * SIZE + ci] : tile[Math.min(SIZE - 1, Math.max(0, j)) * SIZE + Math.min(SIZE - 1, Math.max(0, i))];
    };
    const a = read(ix, iy) * (1 - dx) + read(ix + 1, iy) * dx;
    const b = read(ix, iy + 1) * (1 - dx) + read(ix + 1, iy + 1) * dx;
    return a * (1 - dy) + b * dy;
  };

  const at = (x: number, z: number) => {
    const [mx, my] = frame.xzToMerc(x, z);
    for (const level of loaded) {
      const v = sample(level, mx, my);
      if (v !== null) return v;
    }
    return null;
  };
  return {
    at,
    atOr0: (x, z) => at(x, z) ?? 0,
    tile: (zoom, x, y) => loaded.find((l) => l.zoom === zoom)?.tiles.get(key(x, y)) ?? null,
  };
}
