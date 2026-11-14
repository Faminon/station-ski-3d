# AltiStay — cartes 3D des domaines skiables

Application Next.js autonome : relief, pistes, remontées, lieux, itinéraires à ski et
guidage GPS. Elle n'a ni base de données ni appel au site de recherche AltiStay : toutes
ses données sont des fichiers de `public/data`.

Ce dossier est fait pour être déplacé tel quel dans son propre dépôt.

## Lancer

```bash
npm install
npm run dev      # http://localhost:3001
```

| Adresse | Rôle |
| --- | --- |
| `/` | liste des cartes |
| `/carte/<domaine>` | carte plein écran (`3-vallees`, `foret-blanche`) |
| `/3-vallees` | adresse historique de la carte des 3 Vallées |
| `/embed/<domaine>` | carte à intégrer en iframe sur le site d'une station |
| `/integration` | code d'intégration à transmettre aux stations |

`NEXT_PUBLIC_SEARCH_SITE_URL` (voir `.env.example`) : adresse du site de recherche, pour
les liens « AltiStay » et « Fiche station ». Facultatif.

## Données (`public/data`)

| Fichier | Origine |
| --- | --- |
| `<domaine>-pistes.json`, `<domaine>-stations.json`, `villages/<station>.json` | exportés du site de recherche : `npx tsx prisma/exportDomainMaps.ts <chemin vers public/data>` (dans son dépôt) |
| `<domaine>-pois.json` | `npm run fetch:pois -- <domaine>` |
| `<domaine>-forests.json` | `npm run fetch:forests -- <domaine>` |
| `<domaine>-roads.json` | `npm run fetch:roads -- <domaine>` |
| `<domaine>-corrections.json` | écrit à la main d'après le plan officiel (`src/lib/domainCorrections.ts`). Le site de recherche en garde une copie pour ses chiffres : la reporter là-bas quand elle change. |

Ajouter un domaine : une entrée dans `src/lib/skiDomains.ts`, puis ses fichiers de données.

## Code partagé avec le site de recherche

Le moteur 3D (`src/components/station/`), `src/lib/apis/overpass.ts`, `pisteStats.ts`,
`ignTiles.ts`, `village3d.ts` et `domainCorrections.ts` existent aussi dans le site de
recherche (vue 3D des stations). Les deux copies évoluent séparément.
