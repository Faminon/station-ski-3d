// Sert un paquet hors ligne décompressé (paquets/<domaine>/) comme le ferait l'appli
// mobile : un petit serveur local de fichiers, sans rien d'autre. Pour l'essayer dans
// un navigateur, couper le réseau (outils de développement → hors ligne) et vérifier
// que la carte s'affiche.
//
// Usage : node scripts/servePack.mjs [foret-blanche] [port]   (port 3010 par défaut)

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const slug = process.argv[2] ?? 'foret-blanche';
const port = Number(process.argv[3] ?? 3010);
const root = join(fileURLToPath(new URL('..', import.meta.url)), 'paquets', slug);
if (!existsSync(root)) {
  console.error(`Paquet introuvable : ${root} (npm run pack:build d'abord).`);
  process.exit(1);
}

// Types à servir à l'identique dans l'appli : les modules (.mjs, .js) doivent l'être en JavaScript.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Paquet ${slug} servi sur http://localhost:${port}/embed/${slug}/`));
