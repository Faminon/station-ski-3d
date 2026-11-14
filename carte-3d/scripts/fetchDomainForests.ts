// Récupère depuis OpenStreetMap (Overpass) les forêts d'un domaine relié, pour
// les dessiner en sapins sur la neige de sa carte 3D (façon plan des pistes),
// et les enregistre dans public/data/<domaine>-forests.json.
//
// Usage : npx tsx scripts/fetchDomainForests.ts [3-vallees]   (identifiant du domaine, voir src/lib/skiDomains.ts)
//
// Les contours sont simplifiés (une quinzaine de mètres près) : à l'échelle de
// la carte, le détail est invisible mais multiplierait le poids du fichier.
//
// Données © contributeurs OpenStreetMap, licence ODbL : l'attribution est
// affichée sur la carte et sur la page /credits.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API_USER_AGENT } from '../src/lib/apis/http';
import type { StationPisteMap } from '../src/lib/apis/overpass';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const METERS_PER_DEG_LAT = 110_574;
/** Marge autour du tracé du domaine, pour couvrir les versants visibles depuis les pistes. */
const MARGIN_M = 2500;
const SIMPLIFY_M = 15;
/** Bois plus petits ignorés (en m²) : de simples points à l'échelle de la carte. */
const MIN_AREA_M2 = 4000;

type LonLat = [number, number];
interface Geom {
  lat: number;
  lon: number;
}
interface OsmElement {
  type: 'way' | 'relation';
  id: number;
  geometry?: Geom[];
  members?: { type: string; role: string; geometry?: Geom[] }[];
}

async function overpass(query: string): Promise<OsmElement[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': API_USER_AGENT },
        body: 'data=' + encodeURIComponent(query),
      });
      if (res.ok) return ((await res.json()) as { elements: OsmElement[] }).elements;
      console.warn(`  ${endpoint} → HTTP ${res.status}, nouvel essai…`);
    } catch (err) {
      console.warn(`  ${endpoint} → ${(err as Error).message}, nouvel essai…`);
    }
    await sleep(10_000 * (attempt + 1));
  }
  throw new Error('Overpass indisponible après plusieurs essais.');
}

/** Raccorde les tronçons d'un contour de multipolygone (bouts communs) en anneaux fermés. */
function joinRings(parts: LonLat[][]): LonLat[][] {
  const same = (a: LonLat, b: LonLat) => a[0] === b[0] && a[1] === b[1];
  const rings: LonLat[][] = [];
  const pool = parts.filter((p) => p.length > 1).map((p) => [...p]);
  while (pool.length) {
    let ring = pool.shift()!;
    let grown = true;
    while (!same(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1));
        else if (same(ring[0], p[p.length - 1])) ring = p.concat(ring.slice(1));
        else if (same(ring[0], p[0])) ring = [...p].reverse().concat(ring.slice(1));
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker sur un anneau, en mètres autour de sa latitude. */
function simplify(ring: LonLat[], tolerance: number): LonLat[] {
  const lat0 = ring[0][1];
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = ring.map(([lon, lat]) => [lon * mx, lat * METERS_PER_DEG_LAT]);
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay);
    let best = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / len;
      if (d > best) {
        best = d;
        idx = i;
      }
    }
    if (best > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

function areaM2(ring: LonLat[]): number {
  const mx = 111_320 * Math.cos((ring[0][1] * Math.PI) / 180);
  let a = 0;
  for (let i = 1; i < ring.length; i++) {
    a += ring[i - 1][0] * mx * ring[i][1] * METERS_PER_DEG_LAT - ring[i][0] * mx * ring[i - 1][1] * METERS_PER_DEG_LAT;
  }
  return Math.abs(a / 2);
}

const round = ([lon, lat]: LonLat): LonLat => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];

async function main() {
  const domain = process.argv[2] ?? '3-vallees';
  const file = `${domain}-forests`;

  // Tracé du domaine, exporté du site de recherche (prisma/exportDomainMaps.ts).
  const map = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', `${domain}-pistes.json`), 'utf-8')) as StationPisteMap;

  const mx = 111_320 * Math.cos((map.center.lat * Math.PI) / 180);
  const pts = [...map.pistes, ...map.lifts].flatMap((l) => l.points);
  const [minX, maxX] = [Math.min(...pts.map((p) => p.x)) - MARGIN_M, Math.max(...pts.map((p) => p.x)) + MARGIN_M];
  const [minY, maxY] = [Math.min(...pts.map((p) => p.y)) - MARGIN_M, Math.max(...pts.map((p) => p.y)) + MARGIN_M];
  // y est inversé dans le plan des pistes (nord en haut).
  const bbox = [map.center.lat - maxY / METERS_PER_DEG_LAT, map.center.lng + minX / mx, map.center.lat - minY / METERS_PER_DEG_LAT, map.center.lng + maxX / mx]
    .map((n) => n.toFixed(5))
    .join(',');
  console.log(`${domain} — forêts dans ${bbox}`);

  const elements = await overpass(`[out:json][timeout:180][bbox:${bbox}];
(
  way["landuse"="forest"];
  way["natural"="wood"];
  relation["landuse"="forest"]["type"="multipolygon"];
  relation["natural"="wood"]["type"="multipolygon"];
);
out geom;`);
  console.log(`  ${elements.length} objets OpenStreetMap`);

  const toLonLat = (g: Geom[]): LonLat[] => g.map((p) => [p.lon, p.lat]);
  const polygons: LonLat[][][] = [];
  for (const el of elements) {
    let outers: LonLat[][] = [];
    let inners: LonLat[][] = [];
    if (el.type === 'way' && el.geometry) outers = joinRings([toLonLat(el.geometry)]);
    if (el.type === 'relation' && el.members) {
      const ways = el.members.filter((m) => m.type === 'way' && m.geometry);
      outers = joinRings(ways.filter((m) => m.role !== 'inner').map((m) => toLonLat(m.geometry!)));
      inners = joinRings(ways.filter((m) => m.role === 'inner').map((m) => toLonLat(m.geometry!)));
    }
    for (const outer of outers) {
      if (areaM2(outer) < MIN_AREA_M2) continue;
      const ring = simplify(outer, SIMPLIFY_M).map(round);
      if (ring.length < 4) continue;
      // Clairières rattachées au contour qui les contient (premier point dedans).
      const holes = inners
        .filter((h) => areaM2(h) >= MIN_AREA_M2 && inside(h[0], outer))
        .map((h) => simplify(h, SIMPLIFY_M).map(round))
        .filter((h) => h.length >= 4);
      polygons.push([ring, ...holes]);
    }
  }

  const data = {
    type: 'FeatureCollection',
    features: polygons.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } })),
  };
  const json = JSON.stringify(data);
  const target = join(__dirname, '..', 'public', 'data', `${file}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json);
  console.log(`✓ ${polygons.length} forêts (${(json.length / 1024).toFixed(0)} Ko) → public/data/${file}.json`);
}

function inside([lon, lat]: LonLat, ring: LonLat[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

main()
  .catch((err) => {
    console.error('✗', err.message);
    process.exitCode = 1;
  });
