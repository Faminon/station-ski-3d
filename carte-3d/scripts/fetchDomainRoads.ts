// Récupère depuis OpenStreetMap (Overpass) les routes ouvertes aux voitures d'un
// domaine relié, pour les dessiner sur sa carte 3D, y compris sur la neige
// (façon plan des pistes), et les enregistre dans public/data/<domaine>-roads.json.
//
// Usage : npx tsx scripts/fetchDomainRoads.ts [3-vallees]   (identifiant du domaine, voir src/lib/skiDomains.ts)
//
// Seules les routes (nationales, départementales, communales, rues) sont gardées :
// ni chemins, ni pistes forestières, ni voies de service (parkings, accès privés).
// Les tracés sont simplifiés à quelques mètres près.
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
/** Marge autour du tracé du domaine : routes d'accès aux stations depuis la vallée. */
const MARGIN_M = 2500;
const SIMPLIFY_M = 4;

/** Classe de dessin de chaque type de route OSM : grand axe, route, rue. */
const CLASSES: Record<string, 'major' | 'road' | 'street'> = {
  motorway: 'major',
  trunk: 'major',
  primary: 'major',
  secondary: 'major',
  motorway_link: 'major',
  trunk_link: 'major',
  primary_link: 'major',
  secondary_link: 'major',
  tertiary: 'road',
  tertiary_link: 'road',
  unclassified: 'road',
  residential: 'street',
  living_street: 'street',
};

type LonLat = [number, number];
interface OsmWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

async function overpass(query: string): Promise<OsmWay[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': API_USER_AGENT },
        body: 'data=' + encodeURIComponent(query),
      });
      if (res.ok) return ((await res.json()) as { elements: OsmWay[] }).elements;
      console.warn(`  ${endpoint} → HTTP ${res.status}, nouvel essai…`);
    } catch (err) {
      console.warn(`  ${endpoint} → ${(err as Error).message}, nouvel essai…`);
    }
    await sleep(10_000 * (attempt + 1));
  }
  throw new Error('Overpass indisponible après plusieurs essais.');
}

/** Douglas-Peucker sur une ligne, en mètres autour de sa latitude. */
function simplify(line: LonLat[], tolerance: number): LonLat[] {
  if (line.length <= 2) return line;
  const mx = 111_320 * Math.cos((line[0][1] * Math.PI) / 180);
  const pts = line.map(([lon, lat]) => [lon * mx, lat * METERS_PER_DEG_LAT]);
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
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
  return line.filter((_, i) => keep[i]);
}

const round = ([lon, lat]: LonLat): LonLat => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];

async function main() {
  const domain = process.argv[2] ?? '3-vallees';
  const file = `${domain}-roads`;

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
  console.log(`${domain} — routes dans ${bbox}`);

  const ways = await overpass(`[out:json][timeout:180][bbox:${bbox}];
way["highway"~"^(${Object.keys(CLASSES).join('|')})$"];
out tags geom;`);
  console.log(`  ${ways.length} tronçons OpenStreetMap`);

  const features = [];
  for (const w of ways) {
    const tags = w.tags ?? {};
    const cls = CLASSES[tags.highway];
    // Routes interdites aux voitures (piétonnes, privées) ou souterraines : pas sur la carte.
    if (!cls || !w.geometry || w.geometry.length < 2) continue;
    if (tags.access === 'no' || tags.access === 'private' || tags.motor_vehicle === 'no' || tags.tunnel === 'yes') continue;
    const line = simplify(
      w.geometry.map((g) => [g.lon, g.lat] as LonLat),
      SIMPLIFY_M,
    ).map(round);
    features.push({
      type: 'Feature',
      properties: { cls, ...(tags.ref ? { ref: tags.ref } : {}), ...(tags.name ? { name: tags.name } : {}) },
      geometry: { type: 'LineString', coordinates: line },
    });
  }

  const json = JSON.stringify({ type: 'FeatureCollection', features });
  const target = join(__dirname, '..', 'public', 'data', `${file}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json);
  const byCls = features.reduce<Record<string, number>>((acc, f) => ((acc[f.properties.cls] = (acc[f.properties.cls] ?? 0) + 1), acc), {});
  console.log(`✓ ${features.length} tronçons (${(json.length / 1024).toFixed(0)} Ko) → public/data/${file}.json`, byCls);
}

main()
  .catch((err) => {
    console.error('✗', err.message);
    process.exitCode = 1;
  });
