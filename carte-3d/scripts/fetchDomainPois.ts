// Récupère depuis OpenStreetMap (Overpass) les lieux d'un domaine relié —
// restaurants d'altitude, points de vue, snowparks, toilettes, secours… — pour
// sa carte 3D, et les enregistre dans public/data/<domaine>-pois.json.
//
// Usage : npx tsx scripts/fetchDomainPois.ts [3-vallees]   (identifiant du domaine, voir src/lib/skiDomains.ts)
//
// Ne sont gardés que les lieux à moins de 600 m d'une piste ou d'une remontée
// du tracé de domaine (public/data/<domaine>-pistes.json) : le rectangle interrogé déborde
// sur des villages de vallée qui ne font pas partie du domaine.
//
// Données © contributeurs OpenStreetMap, licence ODbL : l'attribution est
// affichée sur la carte et sur la page /credits.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API_USER_AGENT } from '../src/lib/apis/http';
import type { StationPisteMap } from '../src/lib/apis/overpass';
import { NAMELESS_OK, classifyDomainPoi, type DomainPoi, type DomainPois, type ParkZone } from '../src/lib/domainPois';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const METERS_PER_DEG_LAT = 110_574;
/** Distance maximale à une piste ou une remontée pour faire partie du domaine. */
const NEAR_DOMAIN_M = 600;
/** Deux objets de même nom et de même catégorie à moins de cette distance sont le même lieu (point + bâtiment). */
const SAME_PLACE_M = 80;
/** Snowparks et pistes de luge sont tracés en plusieurs tronçons : un seul repère par aménagement. */
const SAME_RUN_M = 800;

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Requête Overpass avec reprise sur un autre serveur en cas d'échec ou de surcharge. */
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

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

async function main() {
  const domain = process.argv[2] ?? '3-vallees';
  const file = `${domain}-pois`;

  // Tracé du domaine, exporté du site de recherche (prisma/exportDomainMaps.ts).
  const map = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'data', `${domain}-pistes.json`), 'utf-8')) as StationPisteMap;

  const mPerDegLng = 111_320 * Math.cos((map.center.lat * Math.PI) / 180);
  const lines = [...map.pistes, ...map.lifts].map((l) => l.points);
  const xs = lines.flatMap((l) => l.map((p) => p.x));
  const ys = lines.flatMap((l) => l.map((p) => p.y));
  const [minX, maxX, minY, maxY] = [Math.min(...xs) - NEAR_DOMAIN_M, Math.max(...xs) + NEAR_DOMAIN_M, Math.min(...ys) - NEAR_DOMAIN_M, Math.max(...ys) + NEAR_DOMAIN_M];
  // y est inversé dans le plan des pistes (nord en haut).
  const toLat = (y: number) => map.center.lat - y / METERS_PER_DEG_LAT;
  const toLng = (x: number) => map.center.lng + x / mPerDegLng;
  const bbox = [toLat(maxY), toLng(minX), toLat(minY), toLng(maxX)].map((n) => n.toFixed(5)).join(',');
  console.log(`${domain} — ${map.pistes.length} pistes, ${map.lifts.length} remontées, rectangle ${bbox}`);

  // Types utiles au skieur seulement : demander tous les « amenity » (bancs,
  // poubelles…) surcharge Overpass, qui abandonne la requête.
  const elements = await overpass(`[out:json][timeout:180][bbox:${bbox}];
(
  nwr["amenity"~"^(restaurant|fast_food|cafe|ice_cream|bar|pub|nightclub|pharmacy|doctors|clinic|hospital|dentist|bank|atm|post_office|police|townhall|toilets|drinking_water|library|childcare|laundry|parking|bus_station|taxi|fuel|charging_station|cinema|theatre|casino|spa|ski_school)$"];
  nwr["shop"];
  nwr["tourism"~"^(hotel|apartment|chalet|guest_house|hostel|alpine_hut|wilderness_hut|information|viewpoint|picnic_site|attraction|museum)$"];
  nwr["leisure"~"^(sports_centre|swimming_pool|ice_rink|fitness_centre|spa|water_park|bowling_alley|picnic_table)$"];
  nwr["office"="ski_school"];
  nwr["rental"~"ski"];
  nwr["piste:type"~"^(snow_park|playground|sled|ski_jump|ice_skate)$"];
  nwr["emergency"~"^(mountain_rescue|ski_patrol|ambulance_station|defibrillator|phone)$"];
  node["natural"="saddle"]["name"];
  node["mountain_pass"="yes"]["name"];
  nwr["natural"="water"]["name"];
  node["waterway"="waterfall"];
  node["natural"="cave_entrance"]["name"];
);
out tags center;`);
  console.log(`  ${elements.length} objets OpenStreetMap`);

  const nearDomain = (lat: number, lng: number) => {
    const px = (lng - map.center.lng) * mPerDegLng;
    const py = -(lat - map.center.lat) * METERS_PER_DEG_LAT;
    return lines.some((pts) => {
      for (let i = 1; i < pts.length; i++) {
        if (distanceToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= NEAR_DOMAIN_M) return true;
      }
      return false;
    });
  };

  const pois: DomainPoi[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const cls = classifyDomainPoi(tags);
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!cls || lat === undefined || lng === undefined) continue;
    if (tags.access === 'private' || tags.access === 'no') continue;
    if (!tags.name && !NAMELESS_OK.has(cls.category)) continue;
    if (!nearDomain(lat, lng)) continue;

    const name = tags.name ?? cls.kind;
    const reach = tags['piste:type'] ? SAME_RUN_M : SAME_PLACE_M;
    const same = pois.some(
      (p) => p.category === cls.category && p.name === name && Math.hypot((p.lat - lat) * METERS_PER_DEG_LAT, (p.lng - lng) * mPerDegLng) < reach,
    );
    if (same) continue;
    pois.push({
      id: `${el.type}/${el.id}`,
      name,
      category: cls.category,
      kind: tags.cuisine && cls.category === 'restaurant' ? `${cls.kind} · ${tags.cuisine.replace(/[;_]/g, (c) => (c === ';' ? ', ' : ' '))}` : cls.kind,
      lng: round(lng),
      lat: round(lat),
      ...(tags.opening_hours ? { openingHours: tags.opening_hours } : {}),
      ...(tags.website || tags['contact:website'] ? { website: tags.website ?? tags['contact:website'] } : {}),
      ...(tags.phone || tags['contact:phone'] ? { phone: tags.phone ?? tags['contact:phone'] } : {}),
    });
  }

  // Emprises des snowparks et zones ludiques (contours), pour les dessiner en grand sur la carte.
  await sleep(5000);
  const parkEls = (await overpass(`[out:json][timeout:120][bbox:${bbox}];way["piste:type"~"^(snow_park|playground)$"];out tags geom;`)) as (OsmElement & {
    geometry?: { lat: number; lon: number }[];
  })[];
  const zones: ParkZone[] = parkEls
    .filter((el) => el.geometry && el.geometry.length >= 2 && nearDomain(el.geometry[0].lat, el.geometry[0].lon))
    .map((el) => {
      const coordinates = el.geometry!.map((g) => [round(g.lon), round(g.lat)]);
      const [a, z] = [coordinates[0], coordinates[coordinates.length - 1]];
      return {
        kind: el.tags?.['piste:type'] === 'playground' ? ('playground' as const) : ('snowpark' as const),
        ...(el.tags?.name ? { name: el.tags.name } : {}),
        coordinates,
        closed: coordinates.length >= 4 && a[0] === z[0] && a[1] === z[1],
      };
    });
  console.log(`  ${zones.length} emprises de parcs`);

  const data: DomainPois = { fetchedAt: new Date().toISOString(), pois, zones };
  const json = JSON.stringify(data);
  const target = join(__dirname, '..', 'public', 'data', `${file}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json);

  const byCat = pois.reduce<Record<string, number>>((acc, p) => ((acc[p.category] = (acc[p.category] ?? 0) + 1), acc), {});
  console.log(`✓ ${pois.length} lieux (${(json.length / 1024).toFixed(0)} Ko) → public/data/${file}.json`);
  console.log('  ', byCat);
}

main()
  .catch((err) => {
    console.error('✗', err.message);
    process.exitCode = 1;
  });
