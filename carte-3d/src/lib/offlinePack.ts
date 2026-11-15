// Paquet hors ligne : la carte d'un domaine embarquée dans l'appli mobile d'une
// station, avec ses fonds et son relief, pour s'en servir sans réseau.
//
// scripts/buildOfflinePack.ts fabrique le paquet (page de la carte, code, données
// et tuiles du domaine) et inscrit sa description dans la page :
// window.__CARTE_PAQUET__. Sans elle (site, iframe), rien ne change : les tuiles
// viennent des serveurs habituels.
//
// Avec le paquet, chaque tuile est cherchée :
//   1. dans le paquet, si elle y est (zone et zooms téléchargés) ;
//   2. en ligne, si le téléphone a du réseau (au-delà de la zone ou du zoom du paquet) ;
//   3. sinon, dans la tuile parente du paquet, agrandie : moins nette, mais jamais de trou.
//
// Module sans DOM ni MapLibre : il sert aussi dans le worker des barres rocheuses,
// qui reçoit la description du paquet par message (setOfflinePack).

import { IGN_ORTHO_URL, IGN_PLAN_URL } from './ignTiles';

export type TileSet = 'ortho' | 'plan' | 'dem';

/** Relief : Terrain Tiles (Mapzen / AWS Open Data), format « terrarium ». */
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const REMOTE_TILES: Record<TileSet, string> = { ortho: IGN_ORTHO_URL, plan: IGN_PLAN_URL, dem: DEM_URL };
export const TILE_EXT: Record<TileSet, string> = { ortho: 'jpg', plan: 'png', dem: 'png' };
export const TILE_TYPE: Record<TileSet, string> = { ortho: 'image/jpeg', plan: 'image/png', dem: 'image/png' };

/** Zone téléchargée : une emprise et les zooms qu'elle couvre, pour chaque jeu de tuiles. */
export interface PackArea {
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: Record<TileSet, number>;
}

export interface OfflinePack {
  domaine: string;
  /** Date de fabrication (ISO). */
  version: string;
  /** Adresse publique de la carte : liens « Carte AltiStay », partage, conditions en direct. */
  site: string;
  /** Dossier des tuiles dans le paquet : <tiles>/<jeu>/<z>/<x>/<y>.<ext>. */
  tiles: string;
  areas: PackArea[];
  /** `?horsligne` dans l'adresse : la carte fait comme si le téléphone n'avait pas de réseau (essais). */
  horsLigne?: boolean;
}

// `globalThis` et non `window` : Next.js remplace `typeof window` à la compilation, y compris
// dans les workers, où `window` n'existe pas (le worker des barres rocheuses plantait).
let pack: OfflinePack | null = (globalThis as { __CARTE_PAQUET__?: OfflinePack }).__CARTE_PAQUET__ ?? null;
if (pack && /[?&]horsligne(?:[=&]|$)/.test(globalThis.location?.search ?? '')) pack = { ...pack, horsLigne: true };

/** Description du paquet, ou null hors de l'appli (site, iframe). */
export const offlinePack = () => pack;

/** Worker : reçoit la description du paquet de la page. */
export function setOfflinePack(p: OfflinePack | null) {
  pack = p;
}

/** Sans réseau (ou essai `?horsligne`) : inutile de tenter le serveur. */
export const isOffline = () => pack?.horsLigne === true || (typeof navigator !== 'undefined' && navigator.onLine === false);

/**
 * Zoom maximal à demander pour un jeu de tuiles. Paquet sans réseau au chargement : celui du
 * paquet, au-delà MapLibre agrandit lui-même ses tuiles (bien moins coûteux que le repli 3).
 */
export function tileMaxZoom(set: TileSet, remoteMax: number): number {
  if (!pack || !isOffline()) return remoteMax;
  return Math.min(remoteMax, Math.max(...pack.areas.map((a) => a.maxZoom[set])));
}

export function fillTemplate(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** Tuile → emprise [ouest, sud, est, nord]. */
function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lng = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}

/** Tuile présente dans le paquet (emprise recoupée et zoom couvert). */
export function inPack(set: TileSet, z: number, x: number, y: number): boolean {
  if (!pack) return false;
  const [w, s, e, n] = tileBounds(z, x, y);
  return pack.areas.some((a) => z >= a.minZoom && z <= a.maxZoom[set] && e > a.bounds[0] && w < a.bounds[2] && n > a.bounds[1] && s < a.bounds[3]);
}

async function get(url: string, signal?: AbortSignal): Promise<Blob | null> {
  const res = await fetch(url, { signal });
  return res.ok ? res.blob() : null;
}

const localUrl = (set: TileSet, z: number, x: number, y: number) => `${pack!.tiles}/${set}/${z}/${x}/${y}.${TILE_EXT[set]}`;

/**
 * Tuile parente du paquet, agrandie à la taille de la tuile demandée. Relief : pixels
 * recopiés sans lissage (lisser des altitudes codées en couleurs donnerait des valeurs fausses).
 */
async function fromParent(set: TileSet, z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  for (let d = 1; d <= 8 && z - d >= 0; d++) {
    const [pz, px, py] = [z - d, x >> d, y >> d];
    if (!inPack(set, pz, px, py)) continue;
    const parent = await get(localUrl(set, pz, px, py), signal).catch(() => null);
    if (!parent) continue;
    const bitmap = await createImageBitmap(parent);
    const size = bitmap.width;
    const part = size / 2 ** d;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = set !== 'dem';
    ctx.drawImage(bitmap, (x - (px << d)) * part, (y - (py << d)) * part, part, part, 0, 0, size, size);
    bitmap.close();
    return canvas.convertToBlob({ type: set === 'ortho' ? 'image/jpeg' : 'image/png', quality: 0.85 });
  }
  return null;
}

/**
 * Une tuile, d'où qu'elle vienne : paquet, réseau, ou tuile parente du paquet agrandie
 * (voir en tête). Sans paquet : le serveur habituel, comme avant.
 */
export async function fetchTile(set: TileSet, z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob> {
  const remote = fillTemplate(REMOTE_TILES[set], z, x, y);
  if (!pack) {
    const blob = await get(remote, signal);
    if (!blob) throw new Error(`Tuile ${set} ${z}/${x}/${y} indisponible`);
    return blob;
  }
  if (inPack(set, z, x, y)) {
    const local = await get(localUrl(set, z, x, y), signal).catch((e) => {
      if ((e as Error).name === 'AbortError') throw e;
      return null;
    });
    if (local) return local;
  }
  if (!isOffline()) {
    const online = await get(remote, signal).catch((e) => {
      if ((e as Error).name === 'AbortError') throw e;
      return null;
    });
    if (online) return online;
  }
  const scaled = await fromParent(set, z, x, y, signal);
  if (scaled) return scaled;
  throw new Error(`Tuile ${set} ${z}/${x}/${y} absente du paquet`);
}

/** Adresse publique de la carte : celle du paquet dans l'appli, sinon celle de la page. */
export function siteOrigin(): string {
  return pack?.site ?? globalThis.location.origin;
}
