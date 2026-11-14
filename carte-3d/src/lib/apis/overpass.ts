// Overpass API (OpenStreetMap) — https://overpass-api.de/
// Infrastructure officielle du projet OSM, même famille que Nominatim déjà
// utilisé côté géocodage : accès libre, sans clé. Données sous licence ODbL,
// l'attribution est obligatoire et affichée sur chaque plan.
//
// Ce module récupère le tracé RÉEL du domaine — pistes taguées `piste:type`
// avec leur difficulté et leur nom, remontées `aerialway`, sommets `natural=peak`
// — de quoi dessiner un vrai plan des pistes plutôt qu'un schéma inventé.

import { API_USER_AGENT } from './http';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export type PisteDifficulty = 'green' | 'blue' | 'red' | 'black' | 'unknown';

/** Correspondance avec le tag `piste:difficulty` d'OpenStreetMap. */
const DIFFICULTY_MAP: Record<string, PisteDifficulty> = {
  novice: 'green',
  easy: 'blue',
  intermediate: 'red',
  advanced: 'black',
  expert: 'black',
  freeride: 'black',
};

/** Palette des plans des pistes français (vert / bleu / rouge / noir). */
export const PISTE_COLORS: Record<PisteDifficulty, string> = {
  green: '#159c53',
  blue: '#2f6fd0',
  red: '#d32f2f',
  black: '#1a1a20',
  unknown: '#9aa0ab',
};

export const DIFFICULTY_LABELS: Record<PisteDifficulty, string> = {
  green: 'Vertes',
  blue: 'Bleues',
  red: 'Rouges',
  black: 'Noires',
  unknown: 'Non classées',
};

export interface Point {
  x: number;
  y: number;
}

export interface PisteFeature {
  id: number;
  difficulty: PisteDifficulty;
  name?: string;
  /** Longueur approximative du tracé, en mètres */
  length: number;
  points: Point[];
}

export interface LiftFeature {
  id: number;
  liftType: string;
  name?: string;
  length: number;
  points: Point[];
}

export interface PeakFeature {
  id: number;
  name: string;
  elevation?: number;
  point: Point;
}

export interface StationPisteMap {
  center: { lat: number; lng: number };
  pistes: PisteFeature[];
  lifts: LiftFeature[];
  peaks: PeakFeature[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  fetchedAt: string;
}

interface OverpassNode {
  lat: number;
  lon: number;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OverpassNode[];
}

export const METERS_PER_DEG_LAT = 110_574;

export function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Projection équirectangulaire locale centrée sur la station, en mètres.
 * L'axe y est inversé dès la projection pour que le nord soit en haut dans le
 * repère SVG, dont l'origine est en haut à gauche.
 */
function project(lat: number, lng: number, center: { lat: number; lng: number }): Point {
  // Arrondi au mètre : la précision infra-métrique ne se voit pas sur un plan
  // couvrant une dizaine de kilomètres, mais triple la taille du JSON stocké.
  return {
    x: Math.round((lng - center.lng) * metersPerDegLng(center.lat)),
    y: Math.round(-(lat - center.lat) * METERS_PER_DEG_LAT),
  };
}

/**
 * Simplification Douglas-Peucker. Les tracés OSM sont relevés au GPS, souvent
 * un point tous les deux ou trois mètres : à l'échelle d'un plan des pistes, la
 * quasi-totalité de ces points est invisible mais alourdit le HTML servi.
 */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;

  const first = 0;
  const last = points.length - 1;
  const keep = new Set<number>([first, last]);
  const stack: [number, number][] = [[first, last]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    const a = points[start];
    const b = points[end];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);

    let maxDist = -1;
    let maxIndex = -1;

    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      // Distance point-segment ; segment dégénéré => distance au point A.
      const dist =
        segLen === 0
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / segLen;
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }

    if (maxDist > tolerance && maxIndex !== -1) {
      keep.add(maxIndex);
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }

  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function buildQuery(lat: number, lng: number, radiusM: number): string {
  const around = `(around:${radiusM},${lat},${lng})`;
  return (
    `[out:json][timeout:40];(` +
    // `area!=yes` est essentiel : OpenStreetMap cartographie souvent une piste
    // deux fois, par son axe ET par son polygone d'emprise. Tracer le polygone
    // dessine le contour de la piste par-dessus son axe — d'où des doublons
    // sans nom superposés aux pistes nommées (241 sur 757 à Val Thorens).
    `way["piste:type"="downhill"]["area"!="yes"]${around};` +
    `way["aerialway"]["aerialway"!="pylon"]${around};` +
    `node["natural"="peak"]${around};` +
    `);out geom;`
  );
}

/** Un tracé refermé sur lui-même est une emprise, pas une descente. */
function isClosedRing(points: Point[]): boolean {
  if (points.length < 3) return false;
  const first = points[0];
  const last = points[points.length - 1];
  return first.x === last.x && first.y === last.y;
}

// Les tracés de pistes ne bougent quasiment jamais : cache mémoire longue durée,
// attaché à globalThis (comme le cache d'offres de l'agrégateur) pour survivre
// aux graphes de modules distincts compilés par Turbopack en dev.
const globalForPistes = globalThis as unknown as {
  pisteMapCache: Map<string, { data: StationPisteMap | null; expiresAt: number }> | undefined;
};
const pisteMapCache = globalForPistes.pisteMapCache ?? new Map();
globalForPistes.pisteMapCache = pisteMapCache;

const HIT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 30 * 60 * 1000; // un échec réseau se retente sous 30 min

/** Écart maximal toléré entre tracé brut et tracé dessiné, en mètres. */
const SIMPLIFY_TOLERANCE_M = 8;

// Rayon serré par défaut : on veut le domaine de la station, pas tout le massif.
// Certains villages sont toutefois géocodés loin de leur front de neige (Brides,
// Orelle, Val-d'Isère...), d'où l'élargissement de secours.
const DEFAULT_RADIUS_M = 6000;
const FALLBACK_RADIUS_M = 12000;

/** Rayon de recherche de l'emprise du domaine relié autour de la station. */
const LINKED_DOMAIN_SEARCH_M = 8000;

/** Rayon de recherche de l'emprise propre à la station. */
const STATION_BOUNDARY_SEARCH_M = 6000;

async function queryOverpass(query: string): Promise<OverpassElement[] | null> {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': API_USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(35000),
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { elements?: OverpassElement[] };
      if (json.elements) return json.elements;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[apis] Overpass (${endpoint}) indisponible : ${reason}`);
    }
  }
  return null;
}

export interface GeoRing {
  name: string;
  points: { lat: number; lon: number }[];
}

/**
 * Emprise du domaine relié auquel appartient un point (« Les 3 Vallées »,
 * « Tignes - Val d'Isère »...), telle que cartographiée dans OpenStreetMap.
 *
 * Un point de station est contenu dans plusieurs polygones `winter_sports`
 * imbriqués — celui de la station et celui du domaine relié : on retient le
 * plus étendu.
 */
export async function findLinkedDomain(lat: number, lng: number): Promise<GeoRing | null> {
  const largestOf = (elements: OverpassElement[] | null): GeoRing | null => {
    if (!elements) return null;
    const ranked = elements
      .filter((el) => el.geometry && el.geometry.length > 3 && el.tags?.name)
      .map((el) => {
        const lats = el.geometry!.map((g) => g.lat);
        const lons = el.geometry!.map((g) => g.lon);
        const span =
          (Math.max(...lats) - Math.min(...lats)) * (Math.max(...lons) - Math.min(...lons));
        return { name: el.tags!.name, points: el.geometry!, span };
      })
      .sort((a, b) => b.span - a.span);
    return ranked[0] ? { name: ranked[0].name, points: ranked[0].points } : null;
  };

  // 1. L'emprise qui contient réellement la station fait foi. Le point y est
  //    souvent dans plusieurs polygones imbriqués (la station, puis le domaine
  //    relié) : on retient le plus vaste.
  const containing = largestOf(
    await queryOverpass(
      `[out:json][timeout:60];is_in(${lat},${lng})->.a;` +
        `way(pivot.a)["landuse"="winter_sports"]["name"];out geom;`
    )
  );
  if (containing) return containing;

  // 2. Sinon seulement, on cherche au voisinage : beaucoup de villages-stations
  //    sont géocodés en fond de vallée, hors de l'emprise du domaine (Brides,
  //    Orelle, Saint-Martin...). Ce repli passe après, car le plus vaste voisin
  //    peut appartenir à un tout autre massif (Paradiski depuis Courchevel).
  return largestOf(
    await queryOverpass(
      `[out:json][timeout:60];` +
        `way["landuse"="winter_sports"]["name"](around:${LINKED_DOMAIN_SEARCH_M},${lat},${lng});` +
        `out geom;`
    )
  );
}

/** Comparaison de noms tolérante aux accents, tirets et casse. */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Emprise propre à une station, quand OpenStreetMap la distingue du domaine
 * relié. Sans elle, un rayon autour de Vars englobe Risoul : les deux vues du
 * bouton d'échelle deviennent alors quasi identiques.
 *
 * L'égalité des noms doit être stricte — « Vars » ne doit pas se reconnaître
 * dans « Vars/Risoul », qui est justement le domaine relié.
 */
export async function findStationBoundary(
  lat: number,
  lng: number,
  stationName: string
): Promise<GeoRing | null> {
  const elements = await queryOverpass(
    `[out:json][timeout:60];` +
      `way["landuse"="winter_sports"]["name"](around:${STATION_BOUNDARY_SEARCH_M},${lat},${lng});` +
      `out geom;`
  );
  if (!elements) return null;

  const target = normalizeName(stationName);
  const match = elements.find(
    (el) => el.geometry && el.geometry.length > 3 && el.tags?.name && normalizeName(el.tags.name) === target
  );

  return match ? { name: match.tags!.name, points: match.geometry! } : null;
}

/** Lancer de rayon : le point est dedans s'il croise un nombre impair de côtés. */
function isInsideRing(lat: number, lon: number, ring: { lat: number; lon: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon;
    const yi = ring[i].lat;
    const xj = ring[j].lon;
    const yj = ring[j].lat;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Domaine skiable réel autour d'un point. `null` si Overpass est injoignable ou
 * si aucune piste n'est cartographiée ici — l'appelant doit alors le dire au
 * visiteur plutôt que d'afficher un plan inventé.
 *
 * `clipTo` restreint le résultat à une emprise : un simple rayon ramènerait les
 * stations voisines, qu'un plan annoncé « Les 3 Vallées » n'a rien à montrer.
 */
export async function getStationPisteMap(
  lat: number,
  lng: number,
  radiusM = DEFAULT_RADIUS_M,
  clipTo?: GeoRing | null
): Promise<StationPisteMap | null> {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)},${radiusM},${clipTo?.name ?? ''}`;
  const cached = pisteMapCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const center = { lat, lng };
  const elements = await queryOverpass(buildQuery(lat, lng, radiusM));

  if (!elements) {
    pisteMapCache.set(cacheKey, { data: null, expiresAt: Date.now() + MISS_TTL_MS });
    return null;
  }

  const pistes: PisteFeature[] = [];
  const lifts: LiftFeature[] = [];
  const peaks: PeakFeature[] = [];

  for (const el of elements) {
    if (el.type === 'node' && el.tags?.natural === 'peak' && el.lat != null && el.lon != null) {
      if (!el.tags.name) continue;
      const ele = el.tags.ele ? Math.round(parseFloat(el.tags.ele)) : NaN;
      peaks.push({
        id: el.id,
        name: el.tags.name,
        elevation: Number.isFinite(ele) ? ele : undefined,
        point: project(el.lat, el.lon, center),
      });
      continue;
    }

    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const raw = el.geometry.map((n) => project(n.lat, n.lon, center));
    // Longueur mesurée sur le tracé brut, dessin sur le tracé simplifié.
    const length = polylineLength(raw);
    const points = simplify(raw, SIMPLIFY_TOLERANCE_M);

    if (el.tags?.['piste:type'] === 'downhill') {
      // Filet de sécurité : certaines emprises sont dessinées comme des anneaux
      // fermés sans porter le tag `area`, et échappent donc au filtre de requête.
      if (isClosedRing(points)) continue;
      pistes.push({
        id: el.id,
        difficulty: DIFFICULTY_MAP[el.tags['piste:difficulty'] || ''] ?? 'unknown',
        name: el.tags.name,
        length,
        points,
      });
    } else if (el.tags?.aerialway) {
      lifts.push({ id: el.id, liftType: el.tags.aerialway, name: el.tags.name, length, points });
    }
  }

  if (pistes.length === 0) {
    // Centre géocodé trop loin du front de neige : on retente une fois plus large
    // avant de conclure que la station n'est pas cartographiée.
    if (radiusM < FALLBACK_RADIUS_M) {
      const wider = await getStationPisteMap(lat, lng, FALLBACK_RADIUS_M, clipTo);
      // Un `null` ici peut venir d'un Overpass injoignable, pas d'une absence
      // réelle de données : on le garde peu de temps pour pouvoir réessayer.
      pisteMapCache.set(cacheKey, {
        data: wider,
        expiresAt: Date.now() + (wider ? HIT_TTL_MS : MISS_TTL_MS),
      });
      return wider;
    }
    pisteMapCache.set(cacheKey, { data: null, expiresAt: Date.now() + HIT_TTL_MS });
    return null;
  }

  // Découpage sur l'emprise du domaine : Overpass ne sait pas filtrer sur un
  // polygone `landuse` (ses aires ne sont pas générées pour ce tag), le tri se
  // fait donc ici, sur le point médian de chaque tracé.
  if (clipTo) {
    const keep = (points: Point[]) => {
      const mid = points[Math.floor(points.length / 2)];
      const lat2 = center.lat - mid.y / METERS_PER_DEG_LAT;
      const lng2 = center.lng + mid.x / metersPerDegLng(center.lat);
      return isInsideRing(lat2, lng2, clipTo.points);
    };
    for (let i = pistes.length - 1; i >= 0; i--) if (!keep(pistes[i].points)) pistes.splice(i, 1);
    for (let i = lifts.length - 1; i >= 0; i--) if (!keep(lifts[i].points)) lifts.splice(i, 1);
    for (let i = peaks.length - 1; i >= 0; i--) if (!keep([peaks[i].point])) peaks.splice(i, 1);
  }

  // Overpass renvoie chaque tracé en entier dès qu'un seul de ses points touche
  // le rayon : sans bornage, une piste filant vers la vallée voisine étirerait
  // le cadre sur des kilomètres. On borne donc au rayon interrogé.
  const allPoints = [...pistes.flatMap((p) => p.points), ...lifts.flatMap((l) => l.points)];
  const extent = allPoints.reduce(
    (acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      maxX: Math.max(acc.maxX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxY: Math.max(acc.maxY, p.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );

  const clip = {
    minX: Math.max(extent.minX, -radiusM),
    maxX: Math.min(extent.maxX, radiusM),
    minY: Math.max(extent.minY, -radiusM),
    maxY: Math.min(extent.maxY, radiusM),
  };

  const inClip = (p: Point) =>
    p.x >= clip.minX && p.x <= clip.maxX && p.y >= clip.minY && p.y <= clip.maxY;

  // Ce qui tombe entièrement hors cadre n'est pas dessiné : autant ne pas
  // l'envoyer au navigateur.
  const visiblePistes = pistes.filter((p) => p.points.some(inClip));
  const visibleLifts = lifts.filter((l) => l.points.some(inClip));
  const visiblePeaks = peaks.filter((p) => inClip(p.point));

  // Le cadre de clipping est centré sur le point géocodé, qui n'est pas
  // forcément le centre du domaine : sans ce resserrage, une station excentrée
  // (Tignes, Brides...) se dessinerait dans un coin d'un cadre à moitié vide.
  const shown = [
    ...visiblePistes.flatMap((p) => p.points),
    ...visibleLifts.flatMap((l) => l.points),
  ].filter(inClip);

  const bounds = shown.reduce(
    (acc, p) => ({
      minX: Math.min(acc.minX, p.x),
      maxX: Math.max(acc.maxX, p.x),
      minY: Math.min(acc.minY, p.y),
      maxY: Math.max(acc.maxY, p.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );

  return cacheAndReturn(cacheKey, {
    center,
    pistes: visiblePistes,
    lifts: visibleLifts,
    peaks: visiblePeaks,
    bounds,
    fetchedAt: new Date().toISOString(),
  });
}

function cacheAndReturn(key: string, data: StationPisteMap): StationPisteMap {
  pisteMapCache.set(key, { data, expiresAt: Date.now() + HIT_TTL_MS });
  return data;
}

/**
 * Vide le cache mémoire. Utile au script de pré-récupération : sans cela, une
 * relance après échec resservirait le `null` mis en cache au lieu de réinterroger
 * Overpass.
 */
export function clearPisteMapCache(): void {
  pisteMapCache.clear();
}

/**
 * Attend qu'Overpass ait un créneau libre (quota de 2 requêtes simultanées par
 * IP). Interroger poliment évite les rejets et les attentes de 45 secondes.
 */
export async function waitForOverpassSlot(maxWaitMs = 180000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch('https://overpass-api.de/api/status', {
        headers: { 'User-Agent': API_USER_AGENT },
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
      });
      const text = await res.text();

      const available = text.match(/(\d+) slots? available now/);
      if (available && parseInt(available[1], 10) > 0) return true;

      // « Slot available after: <date>, in N seconds. » — on attend ce délai.
      const after = text.match(/in (\d+) seconds?/);
      const waitMs = after ? (parseInt(after[1], 10) + 2) * 1000 : 15000;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 60000)));
    } catch {
      await new Promise((r) => setTimeout(r, 15000));
    }
  }

  return false;
}
