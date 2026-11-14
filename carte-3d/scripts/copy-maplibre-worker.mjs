// Copie le « worker » de MapLibre GL dans public/ : depuis la v6, la
// bibliothèque le charge depuis un fichier séparé que Next.js ne sert pas
// tout seul. Lancé à l'installation et avant `dev` / `build` (package.json),
// pour rester aligné sur la version installée. Le dossier est ignoré par git.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl-worker.mjs');
const target = join(root, 'public', 'vendor', 'maplibre-gl-worker.mjs');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log('maplibre-gl-worker.mjs copié dans public/vendor/');
