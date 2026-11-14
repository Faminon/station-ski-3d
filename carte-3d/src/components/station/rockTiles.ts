// Barres rocheuses sur la carte enneigée : la neige ne tient pas sur les
// parois raides. Chaque tuile « rock://z/x/y » est calculée dans le navigateur :
// pente lue dans les tuiles d'altitude (Terrain Tiles) et, là où elle dépasse
// une quarantaine de degrés en altitude, la roche réelle de la photo aérienne
// IGN, désaturée, recouvre la neige. Ailleurs, la tuile est transparente.

import { addProtocol } from 'maplibre-gl';
import { IGN_ORTHO_URL } from '@/lib/ignTiles';

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Zoom des altitudes : environ 7 m par pixel dans les Alpes, assez pour dessiner les barres rocheuses. */
const DEM_ZOOM = 14;
const SIZE = 256;
const EARTH_CIRCUMFERENCE = 40_075_016.686;

/** Pente (degrés) à partir de laquelle la roche apparaît, et à laquelle elle est entièrement à nu. */
const SLOPE_FROM = 30;
const SLOPE_FULL = 40;
/** Altitudes : en dessous, les pentes raides sont boisées (les sapins les dessinent déjà). */
const ALT_FROM = 1750;
const ALT_FULL = 2050;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface DemTile {
  /** Pente en degrés et altitude en mètres, par pixel. */
  slope: Float32Array;
  alt: Float32Array;
}

async function decode(url: string, signal: AbortSignal): Promise<ImageData> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close();
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

/** Tuiles d'altitude déjà décodées (une tuile sert à 4, 16 ou 64 tuiles de roche plus fines). */
const demCache = new Map<string, Promise<DemTile>>();

function demTile(x: number, y: number): Promise<DemTile> {
  const key = `${x}/${y}`;
  const cached = demCache.get(key);
  if (cached) return cached;
  // Sans signal d'annulation : la tuile d'altitude est partagée entre plusieurs tuiles de roche.
  const promise = decode(DEM_URL.replace('{z}', String(DEM_ZOOM)).replace('{x}', String(x)).replace('{y}', String(y)), new AbortController().signal).then((img) => {
    const alt = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) alt[i] = img.data[i * 4] * 256 + img.data[i * 4 + 1] + img.data[i * 4 + 2] / 256 - 32768;
    // Taille d'un pixel au sol, à la latitude de la tuile.
    const n = 2 ** DEM_ZOOM;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
    const cell = (EARTH_CIRCUMFERENCE * Math.cos(lat)) / (SIZE * n);
    const at = (px: number, py: number) => alt[Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))];
    const slope = new Float32Array(SIZE * SIZE);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        // Méthode de Horn : pente moyenne sur les 8 voisins.
        const dzdx = (at(px + 1, py - 1) + 2 * at(px + 1, py) + at(px + 1, py + 1) - at(px - 1, py - 1) - 2 * at(px - 1, py) - at(px - 1, py + 1)) / (8 * cell);
        const dzdy = (at(px - 1, py + 1) + 2 * at(px, py + 1) + at(px + 1, py + 1) - at(px - 1, py - 1) - 2 * at(px, py - 1) - at(px + 1, py - 1)) / (8 * cell);
        slope[py * SIZE + px] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      }
    }
    return { slope, alt };
  });
  demCache.set(key, promise);
  promise.catch(() => demCache.delete(key));
  // Cache limité : les tuiles les plus anciennes sont oubliées.
  if (demCache.size > 64) demCache.delete(demCache.keys().next().value!);
  return promise;
}

async function rockTile(z: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap> {
  const out = new OffscreenCanvas(SIZE, SIZE);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  // Altitudes : tuile parente au zoom DEM_ZOOM (ou plus grossière si on est plus loin).
  const dz = Math.min(z, DEM_ZOOM);
  const scale = 2 ** (z - dz);
  const dem = await demTile(Math.floor(x / scale), Math.floor(y / scale));
  const ox = (x % scale) * (SIZE / scale);
  const oy = (y % scale) * (SIZE / scale);

  const alpha = new Float32Array(SIZE * SIZE);
  let any = false;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      // Interpolation bilinéaire dans la tuile d'altitude, pour des contours lisses en zoomant.
      const fx = Math.min(SIZE - 1.001, ox + (px + 0.5) / scale - 0.5);
      const fy = Math.min(SIZE - 1.001, oy + (py + 0.5) / scale - 0.5);
      const ix = Math.max(0, Math.floor(fx));
      const iy = Math.max(0, Math.floor(fy));
      const tx = Math.max(0, fx - ix);
      const ty = Math.max(0, fy - iy);
      const i = iy * SIZE + ix;
      const lerp = (a: Float32Array) =>
        (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + SIZE] * (1 - tx) + a[i + SIZE + 1] * tx) * ty;
      const a = smoothstep(SLOPE_FROM, SLOPE_FULL, lerp(dem.slope)) * smoothstep(ALT_FROM, ALT_FULL, lerp(dem.alt));
      alpha[py * SIZE + px] = a;
      if (a > 0.02) any = true;
    }
  }
  // Pas de roche dans la tuile : tuile transparente, sans télécharger la photo.
  if (!any) return createImageBitmap(out);

  // Photo absente (tuile manquante côté IGN, hors couverture) : roche grise uniforme, légèrement grenue.
  const photo = await decode(IGN_ORTHO_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), signal).catch((err) => {
    if (signal.aborted) throw err;
    const img = new ImageData(SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const v = 150 + ((i * 2654435761) >>> 27);
      img.data.set([v, v - 3, v - 8, 255], i * 4);
    }
    return img;
  });
  const d = photo.data;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const [r, g, b] = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    // Roche gris-brun sombre, comme sur les photos d'hiver : la photo d'été (éboulis très clairs)
    // désaturée et assombrie, pour que les barres rocheuses ressortent sur la neige.
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    const v = 34 + l * 0.48;
    d[i * 4] = v * 1.02;
    d[i * 4 + 1] = v * 0.97;
    d[i * 4 + 2] = v * 0.9;
    d[i * 4 + 3] = Math.round(alpha[i] * 245);
  }
  ctx.putImageData(photo, 0, 0);
  return createImageBitmap(out);
}

let registered = false;

/** Protocole « rock:// » des tuiles de roche (une seule fois par page). */
export function registerRockProtocol() {
  if (registered) return;
  registered = true;
  addProtocol('rock', async (params, abortController) => {
    const [z, x, y] = params.url.replace('rock://', '').split('/').map(Number);
    return { data: await rockTile(z, x, y, abortController.signal) };
  });
}
