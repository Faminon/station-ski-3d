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

## Conditions en direct (`/api/live/<domaine>`)

Pour les domaines qui ont une entrée `live` dans `src/lib/skiDomains.ts` (aujourd'hui la Forêt
Blanche). Le serveur interroge chaque source avec son propre cache (`src/lib/live`) ; la carte
relit l'ensemble toutes les 2 minutes tant que l'onglet est visible. Une source muette laisse
son bloc vide, avec la raison affichée, sans gêner les autres.

| Bloc | Source | Cache | Clé |
| --- | --- | --- | --- |
| Pistes et remontées ouvertes, damage | Carte interactive Lumiplan des stations (`lumiplan.ts`). Service public mais **non documenté et sans contrat** : obtenir l'accord de Lumiplan ou des stations avant la mise en production. | 1 min | aucune |
| Bulletin avalanche (massif) | Météo-France, API « Bulletins de risque d'avalanche » (`meteoFrance.ts`) | 30 min | `METEOFRANCE_API_KEY` |
| Vigilance (département) | Météo-France, API « Bulletin Vigilance » ; sans clé, MeteoAlarm (`meteoAlarm.ts`) | 10 min | `METEOFRANCE_API_KEY` |
| Météo (bas et haut du domaine) | Open-Meteo, modèles Météo-France (`openMeteo.ts`). Gratuit pour un usage non commercial seulement. | 30 min | `OPEN_METEO_API_KEY` (usage commercial) |

Lumiplan ne donne pas les tracés : ses noms sont rapprochés de ceux d'OpenStreetMap
(`matchLumiplan.ts`). Les noms restés sans tracé sont listés dans la réponse
(`openings.unmatched`) ; les ajouter à `public/data/<domaine>-live-aliases.json` si un tracé
leur correspond. Sur la carte, l'état est un `feature-state` des tracés existants (aucun
calque ni rechargement de données) : fermé ou hors saison, le tracé est estompé.

## Paquet hors ligne (appli mobile d'une station)

La carte d'un domaine, téléchargeable dans l'appli mobile de la station et utilisable sans
réseau. L'appli sert le paquet décompressé elle-même et l'affiche dans une WebView ; le code à
lui donner est sur la page `/integration`.

```bash
npm run build
npm run pack:build -- --site https://adresse-publique-de-la-carte foret-blanche
npm run pack:serve        # essai : http://localhost:3010/embed/foret-blanche/?horsligne
```

`pack:build` rend la page `/embed/<domaine>` avec le serveur de production, y inscrit la
description du paquet (`window.__CARTE_PAQUET__`), puis copie le code (`.next/static`), les
données, les polices et les tuiles du domaine (relief Terrain Tiles, photos et Plan IGN) : zooms
5 à 11 sur le cadre de la carte, zooms 12 à 16 (photos), 15 (Plan) et 14 (relief) autour des
pistes. Environ 80 Mo pour la Forêt Blanche ; `--estimer` compte les tuiles, `--ortho-max`,
`--plan-max`, `--dem-max` et `--marge` changent la couverture. Résultat dans `paquets/` (ignoré
par git) : `<domaine>.zip` et `<domaine>.json` (version, taille, empreinte), à mettre en ligne
ensemble ; l'appli relit le `.json` pour savoir s'il faut retélécharger le paquet. À refaire après
chaque version de la carte.

Dans le paquet, chaque tuile vient du paquet, sinon du réseau, sinon de sa tuile parente agrandie
(`src/lib/offlinePack.ts`). Les conditions en direct viennent de `--site` (l'API répond à toutes
les origines) ; sans réseau, la carte montre les dernières reçues sur l'appareil (12 h au plus).
`?horsligne` dans l'adresse simule l'absence de réseau.

## Code partagé avec le site de recherche

Le moteur 3D (`src/components/station/`), `src/lib/apis/overpass.ts`, `pisteStats.ts`,
`ignTiles.ts`, `village3d.ts` et `domainCorrections.ts` existent aussi dans le site de
recherche (vue 3D des stations). Les deux copies évoluent séparément.
