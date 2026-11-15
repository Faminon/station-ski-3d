// Appariement des pistes et remontées Lumiplan (noms seuls, sans tracé) avec les tracés
// OpenStreetMap de la carte : même nom une fois simplifié (accents, articles, pluriels,
// préfixes « TSD », « TK »…), même code de remontée (« R5 »), même station ; les cas
// restants passent par la table d'alias écrite à la main (public/data/<domaine>-live-aliases.json).
// Une piste découpée en plusieurs tronçons OSM de même nom reçoit l'état sur tous ses tronçons.

import type { PisteDifficulty, StationPisteMap } from '@/lib/apis/overpass';
import { groomingLabel, lumiplanStatus, type LumiplanItem } from './lumiplan';
import type { LiveItemState } from './types';

export interface LiveAliases {
  /** Nom Lumiplan (tel qu'il apparaît dans le flux) → noms des tracés OpenStreetMap. */
  pistes?: Record<string, string[]>;
  lifts?: Record<string, string[]>;
}

export interface MatchResult {
  pistes: Record<string, LiveItemState>;
  lifts: Record<string, LiveItemState>;
  unmatched: string[];
}

/** Mots sans valeur pour comparer deux noms. */
const STOP_WORDS = new Set(['le', 'la', 'les', 'l', 'de', 'des', 'du', 'd', 'et', 'a', 'au', 'aux']);
/** Préfixes de remontée (« TSD Mayt », « TK Crévoux 1 », « Tapis Claux »). */
const LIFT_WORDS = new Set(['tsd', 'ts', 'tsf', 'tk', 'tmx', 'tc', 'tph', 'tapis', 'telesiege', 'teleski', 'telecabine', 'telemix', 'tele', 'pulse', 'telepulse']);
const CODE = /^[a-z]\d{1,2}$/;

function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Nom simplifié et codes de remontée (« Platte de la Nonne R5 » → « platte nonne », [r5]). */
export function nameKey(name: string, lift = false): { key: string; codes: string[] } {
  const codes: string[] = [];
  const kept: string[] = [];
  for (let w of words(name)) {
    if (STOP_WORDS.has(w)) continue;
    if (lift && CODE.test(w)) {
      codes.push(w);
      continue;
    }
    if (lift && LIFT_WORDS.has(w)) continue;
    if (w === 'inferieure' || w === 'inferieur') w = 'inf';
    else if (w === 'superieure' || w === 'superieur') w = 'sup';
    // Pluriels : « Marmottes » = « Marmotte », « Pinatiaux » = « Pinatiau ».
    else if (w.length > 3 && /[sx]$/.test(w)) w = w.slice(0, -1);
    kept.push(w);
  }
  return { key: kept.join(' '), codes };
}

const LEVELS: Record<string, PisteDifficulty> = { GREEN: 'green', BLUE: 'blue', RED: 'red', BLACK: 'black' };

/** Famille de remontée, pour départager deux remontées de même nom (« TK Écrins » / « Tapis Écrins »). */
function liftFamily(type: string | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('carpet')) return 'carpet';
  if (t.includes('surface') || /platter|drag|t-bar|j-bar|rope/.test(t)) return 'surface';
  if (t.includes('gondola') || t.includes('cable_car') || t.includes('mixed') || t.includes('funicular')) return 'cabin';
  if (t.includes('chair')) return 'chair';
  return t;
}

interface Track {
  id: number;
  key: string;
  codes: string[];
  resortId: string;
  /** Pistes : couleur ; remontées : famille. */
  kind: string;
  points: { x: number; y: number }[];
}

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Station la plus probable d'un tracé : celle de la remontée codée (« R5 », « V9 ») la plus proche. */
function nearestResort(points: { x: number; y: number }[], coded: Track[]): string {
  let best = '';
  let bestDistance = Infinity;
  const step = Math.max(1, Math.floor(points.length / 6));
  for (let i = 0; i < points.length; i += step) {
    for (const lift of coded) {
      for (let j = 1; j < lift.points.length; j++) {
        const d = distanceToSegment(points[i], lift.points[j - 1], lift.points[j]);
        if (d < bestDistance) {
          bestDistance = d;
          best = lift.resortId;
        }
      }
    }
  }
  return best;
}

/** Tracés de la carte, préparés une fois (le tracé du domaine ne change pas entre deux appels). */
export function prepareTracks(map: StationPisteMap, resorts: { id: string; liftCode?: string }[]) {
  const resortOfCode = (codes: string[]) => resorts.find((r) => r.liftCode && codes.some((c) => c[0] === r.liftCode!.toLowerCase()))?.id ?? '';
  const lifts: Track[] = map.lifts
    .filter((l) => l.name)
    .map((l) => {
      const { key, codes } = nameKey(l.name!, true);
      return { id: l.id, key, codes, resortId: resortOfCode(codes), kind: liftFamily(l.liftType), points: l.points };
    });
  const coded = lifts.filter((l) => l.resortId);
  for (const lift of lifts) if (!lift.resortId) lift.resortId = nearestResort(lift.points, coded);
  const pistes: Track[] = map.pistes
    .filter((p) => p.name)
    .map((p) => ({ id: p.id, key: nameKey(p.name!).key, codes: [], resortId: nearestResort(p.points, coded), kind: p.difficulty, points: p.points }));
  return { pistes, lifts };
}

export type PreparedTracks = ReturnType<typeof prepareTracks>;

function stateOf(item: LumiplanItem): LiveItemState | null {
  const s = lumiplanStatus(item.status);
  if (!s) return null;
  return {
    ...s,
    ...(item.kind === 'trail' && groomingLabel(item.grooming) ? { grooming: groomingLabel(item.grooming) } : {}),
    ...(item.message ? { message: item.message } : {}),
    ...(item.hours && s.status === 'open' ? { hours: item.hours } : {}),
  };
}

/** Tracés candidats d'un élément Lumiplan, avant arbitrage entre éléments concurrents. */
function candidates(item: LumiplanItem, tracks: Track[], aliases: string[] | undefined, sharedKeys: Set<string>): Track[] {
  const lift = item.kind === 'lift';
  const { key, codes } = nameKey(item.name, lift);
  // Remontée codée des deux côtés (« R5 Plate » / « Platte de la Nonne R5 ») : le code suffit.
  if (lift && codes.length) {
    const byCode = tracks.filter((t) => t.codes.some((c) => codes.includes(c)));
    if (byCode.length) return byCode;
  }
  const keys = new Set([key, ...(aliases ?? []).map((a) => nameKey(a, lift).key)]);
  let found = tracks.filter((t) => keys.has(t.key));
  // Piste découpée sur le plan OSM (« Pinatiaux Inférieure », « Pinatiaux Supérieure »).
  if (!found.length && !lift && key) found = tracks.filter((t) => t.key.startsWith(`${key} `));
  if (!found.length) return [];
  // Même nom dans les deux stations (« Col Sans Nom », « Marmottes ») : celle de l'élément. Seulement
  // dans ce cas : la station d'un tracé est devinée (remontée la plus proche) et peut se tromper en limite.
  if (sharedKeys.has(key)) {
    const sameResort = found.filter((t) => t.resortId === item.resortId);
    if (sameResort.length) found = sameResort;
  }
  // Même nom pour deux remontées de types différents (« TK Écrins », « Tapis Écrins »).
  if (lift) {
    const family = liftFamily(item.liftType);
    const sameFamily = found.filter((t) => t.kind === family);
    if (sameFamily.length) found = sameFamily;
  }
  return found;
}

/** État en direct de chaque tracé apparié, et noms Lumiplan restés sans tracé. */
export function matchLumiplan(items: LumiplanItem[], tracks: PreparedTracks, aliases: LiveAliases | null, resortName: (id: string) => string): MatchResult {
  const result: MatchResult = { pistes: {}, lifts: {}, unmatched: [] };
  for (const kind of ['trail', 'lift'] as const) {
    const pool = kind === 'lift' ? tracks.lifts : tracks.pistes;
    const aliasTable = (kind === 'lift' ? aliases?.lifts : aliases?.pistes) ?? {};
    // Tracé → éléments qui le revendiquent, avec une note pour départager.
    const claims = new Map<number, { item: LumiplanItem; score: number }[]>();
    // Noms présents dans plusieurs stations.
    const resortsByKey = new Map<string, Set<string>>();
    for (const item of items) {
      if (item.kind !== kind) continue;
      const key = nameKey(item.name, kind === 'lift').key;
      resortsByKey.set(key, (resortsByKey.get(key) ?? new Set()).add(item.resortId));
    }
    const sharedKeys = new Set([...resortsByKey].filter(([, r]) => r.size > 1).map(([k]) => k));
    for (const item of items) {
      if (item.kind !== kind) continue;
      // Pistes : ski alpin seulement (les snowparks, itinéraires de randonnée, VTT n'ont pas de tracé de piste).
      if (kind === 'trail' && item.trailType !== 'DOWNHILL_SKIING') continue;
      const found = candidates(item, pool, aliasTable[item.name], sharedKeys);
      if (!found.length) {
        result.unmatched.push(`${resortName(item.resortId)} · ${item.name}`);
        continue;
      }
      for (const track of found) {
        const score = (track.resortId === item.resortId ? 1 : 0) + (kind === 'trail' && LEVELS[item.level ?? ''] === track.kind ? 2 : 0);
        const list = claims.get(track.id) ?? [];
        list.push({ item, score });
        claims.set(track.id, list);
      }
    }
    const target = kind === 'lift' ? result.lifts : result.pistes;
    for (const [id, list] of claims) {
      const best = list.reduce((a, b) => (b.score > a.score ? b : a));
      const state = stateOf(best.item);
      if (state) target[String(id)] = state;
    }
  }
  result.unmatched.sort((a, b) => a.localeCompare(b, 'fr'));
  return result;
}
