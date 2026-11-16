// Fabrique le paquet hors ligne d'un domaine : la carte 3D à embarquer dans l'appli
// mobile d'une station, utilisable sans réseau (voir src/lib/offlinePack.ts).
//
// Usage (après `npm run build`) :
//   npx tsx scripts/buildOfflinePack.ts --site https://carte.exemple.fr [foret-blanche]
//
// Options :
//   --site <adresse>     adresse publique de la carte (obligatoire, ou variable CARTE_PUBLIC_URL) :
//                        liens « Carte AltiStay », partage et conditions en direct.
//   --ortho-max <z>      zoom maximal des photos aériennes IGN (16 par défaut, 2,4 m par pixel)
//   --plan-max <z>       zoom maximal du Plan IGN (15 par défaut)
//   --dem-max <z>        zoom maximal du relief (14 par défaut, ce que lisent les barres rocheuses)
//   --marge <km>         marge autour des pistes et remontées (2 km par défaut)
//   --estimer            compte les tuiles sans rien télécharger
//
// Produit, dans paquets/ (ignoré par git) :
//   <domaine>/           le paquet décompressé (pour l'essayer : npm run pack:serve)
//   <domaine>.zip        le paquet à mettre en ligne, que l'appli télécharge
//   <domaine>.json       sa description (version, taille, empreinte) : l'appli la relit pour
//                        savoir s'il y a une mise à jour, sans retélécharger le paquet.
//
// Contenu : la page /embed/<domaine> rendue par le serveur de production, le code
// (.next/static), les données du domaine (public/data), les polices, le worker de MapLibre,
// et les tuiles : relief (Terrain Tiles, AWS Open Data) et fonds IGN (Licence Ouverte
// Etalab 2.0), sur deux zones :
//   - large  : le cadre de la carte (maxBounds), zooms 5 à 11, pour l'horizon ;
//   - détail : les pistes et remontées et leur marge, du zoom 12 aux zooms maximaux.
// Les tuiles déjà téléchargées sont gardées dans paquets/.tuiles : relancer le script est rapide.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { API_USER_AGENT } from '../src/lib/apis/http';
import type { StationPisteMap } from '../src/lib/apis/overpass';
import { domainDetailBounds } from '../src/lib/domainArea';
import { REMOTE_TILES, TILE_EXT, fillTemplate, type OfflinePack, type PackArea, type TileSet } from '../src/lib/offlinePack';
import { skiDomain } from '../src/lib/skiDomains';

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'paquets');
const TILE_CACHE = join(OUT, '.tuiles');
const SETS: TileSet[] = ['dem', 'ortho', 'plan'];
/** Zone large : zooms couverts (le relief lointain se contente de tuiles très grossières, dès le zoom 5). */
const WIDE_ZOOMS = [5, 11] as const;
const DETAIL_MIN_ZOOM = 12;
/** Téléchargements simultanés : la Géoplateforme de l'IGN limite le débit par adresse. */
const CONCURRENCY = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Options ------------------------------------------------------------------------------

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
/** Options suivies d'une valeur ; le reste (hors --estimer) est l'identifiant du domaine. */
const VALUED = new Set(['--site', '--ortho-max', '--plan-max', '--dem-max', '--marge']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
const slug = positional[0] ?? 'foret-blanche';
const site = (option('site') ?? process.env.CARTE_PUBLIC_URL ?? '').replace(/\/$/, '');
const estimateOnly = flag('estimer');
const maxZoom: Record<TileSet, number> = {
  ortho: Number(option('ortho-max') ?? 16),
  plan: Number(option('plan-max') ?? 15),
  dem: Number(option('dem-max') ?? 14),
};
const marginKm = Number(option('marge') ?? 2);

const domain = skiDomain(slug);
if (!domain?.embed) {
  console.error(`Domaine « ${slug} » inconnu ou non intégrable (voir src/lib/skiDomains.ts).`);
  process.exit(1);
}
if (!site && !estimateOnly) {
  console.error('Adresse publique de la carte manquante : --site https://… (ou variable CARTE_PUBLIC_URL).');
  process.exit(1);
}

// ---- Zones et tuiles ----------------------------------------------------------------------

function detailBounds(): [number, number, number, number] {
  const map = JSON.parse(readFileSync(join(ROOT, 'public', domain!.pistesUrl), 'utf8')) as StationPisteMap;
  return domainDetailBounds(map, marginKm);
}

function wideBounds(): [number, number, number, number] {
  // Même cadre que la carte (maxBounds, Domain3DViewer.tsx).
  const [lng, lat] = domain!.center;
  return [lng - 0.7, lat - 0.5, lng + 0.7, lat + 0.5];
}

function tileRange(bounds: [number, number, number, number], z: number) {
  const n = 2 ** z;
  const x = (lng: number) => Math.floor(((lng + 180) / 360) * n);
  const y = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n);
  };
  return { x0: x(bounds[0]), x1: x(bounds[2]), y0: y(bounds[3]), y1: y(bounds[1]) };
}

interface Tile {
  set: TileSet;
  z: number;
  x: number;
  y: number;
}

function listTiles(areas: PackArea[]): Tile[] {
  const seen = new Set<string>();
  const tiles: Tile[] = [];
  for (const area of areas) {
    for (const set of SETS) {
      for (let z = area.minZoom; z <= area.maxZoom[set]; z++) {
        const { x0, x1, y0, y1 } = tileRange(area.bounds, z);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const key = `${set}/${z}/${x}/${y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tiles.push({ set, z, x, y });
          }
        }
      }
    }
  }
  return tiles;
}

const tilePath = (t: Tile) => `${t.set}/${t.z}/${t.x}/${t.y}.${TILE_EXT[t.set]}`;

/** Télécharge une tuile dans le cache (3 essais). Faux si le serveur n'en a pas (hors couverture). */
async function download(t: Tile): Promise<boolean> {
  const file = join(TILE_CACHE, tilePath(t));
  if (existsSync(file)) return true;
  const url = fillTemplate(REMOTE_TILES[t.set], t.z, t.x, t.y);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': API_USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404 || res.status === 400) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
      return true;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url} : ${(err as Error).message}`);
      await sleep(1000 * attempt);
    }
  }
}

async function downloadAll(tiles: Tile[]): Promise<Tile[]> {
  const kept: Tile[] = [];
  let next = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < tiles.length) {
      const t = tiles[next++];
      if (await download(t)) kept.push(t);
      done++;
      if (done % 200 === 0 || done === tiles.length) {
        const s = Math.round((Date.now() - started) / 1000);
        process.stdout.write(`\r  tuiles : ${done} / ${tiles.length} (${s} s)   `);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  return kept;
}

// ---- Page rendue par le serveur de production ----------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Lance `next start` le temps de lire la page et l'icône du site. */
async function renderPage(): Promise<{ html: string; favicon: Buffer | null }> {
  const buildId = join(ROOT, '.next', 'BUILD_ID');
  if (!existsSync(buildId)) throw new Error('Pas de version de production : lancer `npm run build` avant.');
  const port = await freePort();
  const server = spawn(process.execPath, [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`${base}/embed/${slug}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const ico = await fetch(`${base}/favicon.ico`);
        const favicon = ico.ok ? Buffer.from(await ico.arrayBuffer()) : null;
        // La page doit venir de la même version que le code copié de .next/static.
        const id = readFileSync(buildId, 'utf8').trim();
        if (!html.includes(id)) console.warn('  attention : la page ne cite pas la version de .next/BUILD_ID');
        return { html, favicon };
      } catch (err) {
        if (i > 60) throw new Error(`Serveur de production injoignable : ${(err as Error).message}`);
        await sleep(500);
      }
    }
  } finally {
    server.kill();
  }
}

/** Description du paquet inscrite dans la page, avant tout autre script. */
function injectPack(html: string, pack: OfflinePack): string {
  const json = JSON.stringify(pack).replace(/</g, '\\u003c');
  const tag = `<script>window.__CARTE_PAQUET__=${json}</script>`;
  if (!/<head[^>]*>/.test(html)) throw new Error('Page sans <head> : impossible d’y inscrire le paquet.');
  return html.replace(/<head[^>]*>/, (m) => m + tag);
}

// ---- Archive ZIP (sans dépendance) ----------------------------------------------------------

/** Fichiers déjà compressés : stockés tels quels (les recompresser ne gagne rien). */
const STORED = /\.(jpe?g|png|woff2?|ico|zip)$/i;

function writeZip(dir: string, target: string) {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  if (files.length > 65_000) throw new Error('Trop de fichiers pour une archive ZIP simple (65 000 au plus).');
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(dir, file).split(sep).join('/'), 'utf8');
    const raw = readFileSync(file);
    const store = STORED.test(file);
    const data = store ? raw : deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(0, 10); // heure et date : sans objet
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(store ? 0 : 8, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    chunks.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...chunks, centralBuf, end]));
}

// ---- Fabrication ------------------------------------------------------------------------------

async function main() {
  const areas: PackArea[] = [
    { bounds: wideBounds(), minZoom: WIDE_ZOOMS[0], maxZoom: { ortho: WIDE_ZOOMS[1], plan: WIDE_ZOOMS[1], dem: WIDE_ZOOMS[1] } },
    { bounds: detailBounds(), minZoom: DETAIL_MIN_ZOOM, maxZoom },
  ];
  const tiles = listTiles(areas);
  const bySet = SETS.map((s) => `${s} ${tiles.filter((t) => t.set === s).length}`).join(', ');
  console.log(`${domain!.name} : ${tiles.length} tuiles (${bySet}).`);
  console.log(`  zone détaillée : ${areas[1].bounds.map((v) => v.toFixed(3)).join(', ')}`);
  if (estimateOnly) return;

  const dir = join(OUT, slug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  console.log('Page de la carte (serveur de production)…');
  const { html, favicon } = await renderPage();
  const pack: OfflinePack = { domaine: slug, version: new Date().toISOString(), site, tiles: '/tuiles', areas };
  const page = injectPack(html, pack);
  // Deux entrées : /embed/<domaine>/ (serveur local avec page d'index) et /index.html (fichiers bruts).
  mkdirSync(join(dir, 'embed', slug), { recursive: true });
  writeFileSync(join(dir, 'embed', slug, 'index.html'), page);
  writeFileSync(join(dir, 'index.html'), page);
  if (favicon) writeFileSync(join(dir, 'favicon.ico'), favicon);

  console.log('Code, données et polices…');
  cpSync(join(ROOT, '.next', 'static'), join(dir, '_next', 'static'), { recursive: true });
  cpSync(join(ROOT, 'public', 'vendor'), join(dir, 'vendor'), { recursive: true });
  cpSync(join(ROOT, 'public', 'fonts'), join(dir, 'fonts'), { recursive: true });
  const dataFiles = [domain!.pistesUrl, domain!.stationsUrl, domain!.poisUrl, domain!.forestsUrl, domain!.roadsUrl, domain!.correctionsUrl, domain!.live?.aliasesUrl];
  for (const url of dataFiles) if (url) cpSync(join(ROOT, 'public', url), join(dir, url));
  const stations = JSON.parse(readFileSync(join(ROOT, 'public', domain!.stationsUrl), 'utf8')) as { stations: { id: string; village?: boolean }[] };
  for (const s of stations.stations.filter((st) => st.village)) {
    const file = join('data', 'villages', `${s.id}.json`);
    if (existsSync(join(ROOT, 'public', file))) cpSync(join(ROOT, 'public', file), join(dir, file));
  }

  console.log('Tuiles (fonds IGN et relief)…');
  const kept = await downloadAll(tiles);
  for (const t of kept) cpSync(join(TILE_CACHE, tilePath(t)), join(dir, 'tuiles', tilePath(t)));
  if (kept.length < tiles.length) console.log(`  ${tiles.length - kept.length} tuiles absentes des serveurs (hors couverture).`);

  console.log('Archive…');
  const zip = join(OUT, `${slug}.zip`);
  writeZip(dir, zip);
  const data = readFileSync(zip);
  const info = {
    domaine: slug,
    version: pack.version,
    taille: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  writeFileSync(join(OUT, `${slug}.json`), JSON.stringify(info, null, 2) + '\n');
  console.log(`Paquet prêt : paquets/${slug}.zip (${(data.length / 1e6).toFixed(1)} Mo), description paquets/${slug}.json.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
