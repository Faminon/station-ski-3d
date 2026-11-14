// Réglages de MapLibre pour les cartes 3D, mesurés sur la Forêt Blanche en
// grand format (1920 × 800, vue inclinée à 65°, rotation de la caméra) :
// environ 21 ms de calcul par image avant, environ 10 ms après.
//
// 1. Drapage sur le relief (10 ms par image → moins d'1 ms) : à chaque image,
//    MapLibre cherche, pour chaque tuile de chaque source posée au sol, les
//    tuiles de relief qu'elle recouvre. Il le fait en créant deux objets par
//    couple de tuiles avant même de vérifier qu'elles se recouvrent (près de
//    10 000 couples par image ici, presque tous sans rapport). On ne lui confie
//    que les tuiles de relief qui recouvrent la tuile demandée : résultat
//    identique (vérifié sur 600 tuiles), sans le travail inutile.
// 2. Tuiles lointaines (≈ 4 ms par image) : en vue inclinée, la précision des
//    tuiles baisse plus vite vers l'horizon (12 niveaux au lieu de 9,3) et leur
//    nombre est davantage plafonné (×1,5 au lieu de ×3). Le premier plan garde
//    toute sa précision.
// 3. Une seule « pile » de calques au sol : avec le relief, MapLibre plaque les
//    calques au sol sur le terrain par paquets de calques consécutifs, et
//    redessine tout le relief pour chaque paquet. Un calque 3D ou une étiquette
//    glissé entre deux calques au sol coupe le paquet en deux. On les place donc
//    tous après le dernier calque au sol : l'image ne change pas (les calques au
//    sol sont plaqués sur le relief, les volumes et étiquettes dessinés
//    par-dessus), mais le relief n'est dessiné qu'une fois.

import type { Map as MlMap } from 'maplibre-gl';

/** Réglage des tuiles en vue inclinée (voir `Map#setSourceTileLodParams`) ; MapLibre : 9,314 et 3. */
const LOD_MAX_ZOOM_LEVELS = 12;
const LOD_TILE_COUNT_RATIO = 1.5;

/** Types de calques que MapLibre plaque sur le relief (les autres sont dessinés par-dessus). */
const DRAPED_TYPES = new Set(['background', 'fill', 'line', 'raster', 'hillshade', 'color-relief']);

// ---- 1. Drapage -------------------------------------------------------------------------

interface CanonicalTileID {
  equals(other: CanonicalTileID): boolean;
  isChildOf(other: CanonicalTileID): boolean;
}
interface TerrainTileManagerInternals {
  _renderableTilesKeys?: string[];
  _tiles?: Record<string, { tileID: { canonical: CanonicalTileID } }>;
  _getTerrainCoordsForRegularTile?: (tileID: { canonical: CanonicalTileID }) => unknown;
  __carteTerrainCoordsPatched?: boolean;
}

/** Applique le correctif au gestionnaire des tuiles de relief (une fois pour toutes les cartes). */
function patchTerrainCoords(map: MlMap) {
  const manager = (map as unknown as { terrain?: { tileManager?: TerrainTileManagerInternals } }).terrain?.tileManager;
  if (!manager) return;
  const proto = Object.getPrototypeOf(manager) as TerrainTileManagerInternals;
  const original = proto._getTerrainCoordsForRegularTile;
  // Version de MapLibre différente (méthode absente ou renommée) : on laisse MapLibre tel quel.
  if (proto.__carteTerrainCoordsPatched || typeof original !== 'function') return;
  proto.__carteTerrainCoordsPatched = true;
  proto._getTerrainCoordsForRegularTile = function (this: TerrainTileManagerInternals, tileID) {
    const all = this._renderableTilesKeys;
    const tiles = this._tiles;
    if (!Array.isArray(all) || !tiles) return original.call(this, tileID);
    const canonical = tileID.canonical;
    // Mêmes critères que MapLibre : tuile identique, enfant ou parent.
    const related: string[] = [];
    for (const key of all) {
      const terrain = tiles[key]?.tileID.canonical;
      if (terrain && (terrain.equals(canonical) || terrain.isChildOf(canonical) || canonical.isChildOf(terrain))) related.push(key);
    }
    this._renderableTilesKeys = related;
    try {
      return original.call(this, tileID);
    } finally {
      this._renderableTilesKeys = all;
    }
  };
}

// ---- 2 et 3. Tuiles lointaines et pile unique ---------------------------------------------

function applyTileLod(map: MlMap, sourceId?: string) {
  try {
    map.setSourceTileLodParams(LOD_MAX_ZOOM_LEVELS, LOD_TILE_COUNT_RATIO, sourceId);
  } catch {
    // Source retirée entre-temps : rien à régler.
  }
}

/** Place après le dernier calque au sol les calques 3D et étiquettes glissés entre deux calques au sol. */
function groupDrapedLayers(map: MlMap) {
  const order = map.getLayersOrder();
  const draped = (id: string) => DRAPED_TYPES.has(map.getLayer(id)?.type ?? '');
  let lastDraped = -1;
  order.forEach((id, i) => {
    if (draped(id)) lastDraped = i;
  });
  if (lastDraped < 0) return;
  const toMove = order.slice(0, lastDraped).filter((id) => !draped(id));
  if (!toMove.length) return;
  // Juste avant le premier calque qui suit déjà le dernier calque au sol, dans leur ordre d'origine.
  const anchor = order[lastDraped + 1];
  for (const id of toMove) map.moveLayer(id, anchor);
}

/** Installe les trois réglages ; à appeler juste après la création de la carte. */
export function tuneMapPerformance(map: MlMap): () => void {
  let regroupTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRegroup = () => {
    clearTimeout(regroupTimer);
    regroupTimer = setTimeout(() => {
      if (map.style) groupDrapedLayers(map);
    }, 0);
  };

  // Sources et calques ajoutés après le style d'origine : même traitement.
  const addSource = map.addSource.bind(map);
  map.addSource = ((id, source) => {
    const result = addSource(id, source);
    applyTileLod(map, id);
    return result;
  }) as typeof map.addSource;
  const addLayer = map.addLayer.bind(map);
  map.addLayer = ((layer, beforeId) => {
    const result = addLayer(layer, beforeId);
    scheduleRegroup();
    return result;
  }) as typeof map.addLayer;

  const onStyle = () => {
    patchTerrainCoords(map);
    applyTileLod(map);
    scheduleRegroup();
  };
  const onTerrain = () => patchTerrainCoords(map);
  map.on('style.load', onStyle);
  map.on('terrain', onTerrain);
  if (map.isStyleLoaded()) onStyle();

  return () => {
    clearTimeout(regroupTimer);
    map.off('style.load', onStyle);
    map.off('terrain', onTerrain);
  };
}
