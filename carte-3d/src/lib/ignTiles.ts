// Fonds de carte de l'IGN, servis par la Géoplateforme (data.geopf.fr) :
// photographies aériennes et Plan IGN. Données publiques sous Licence Ouverte
// Etalab 2.0 : gratuites, sans clé, réutilisables y compris commercialement,
// à condition de citer l'IGN (voir IGN_ATTRIBUTION, affichée sur chaque carte
// et sur la page /credits).
//
// Format WMTS en projection Web Mercator (« PM ») : mêmes tuiles {z}/{x}/{y}
// que les fonds habituels, utilisables telles quelles par Leaflet et MapLibre.

const WMTS =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

/** Photographies aériennes (BD ORTHO®, 20 cm), jusqu'au zoom 19. */
export const IGN_ORTHO_URL = `${WMTS}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&FORMAT=image/jpeg`;

/** Plan IGN : carte topographique (relief ombré, toponymes, chemins), jusqu'au zoom 19. */
export const IGN_PLAN_URL = `${WMTS}&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&FORMAT=image/png`;

export const IGN_MAX_ZOOM = 19;

export const IGN_ATTRIBUTION = 'Fonds © <a href="https://www.ign.fr" target="_blank" rel="noopener">IGN</a> – Géoplateforme (Licence Ouverte Etalab 2.0)';
