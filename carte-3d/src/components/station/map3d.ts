// Socle commun des cartes 3D (vue d'une station, carte des 3 Vallées) : fonds,
// relief, conversion du plan des pistes. Réservé au navigateur (MapLibre, WebGL).

import { getVersion, setWorkerUrl, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import type { StationPisteMap } from '@/lib/apis/overpass';
import { IGN_ATTRIBUTION, IGN_MAX_ZOOM, IGN_ORTHO_URL, IGN_PLAN_URL } from '@/lib/ignTiles';
import { isSkierLift } from '@/lib/pisteStats';
import { registerRockProtocol } from './rockTiles';

// Worker MapLibre servi depuis public/vendor (copié par scripts/copy-maplibre-worker.mjs) ;
// la version en paramètre évite de garder un ancien worker en cache après une mise à jour.
setWorkerUrl(`/vendor/maplibre-gl-worker.mjs?v=${getVersion()}`);
// Barres rocheuses calculées dans le navigateur (pente + photo aérienne) : voir rockTiles.ts.
registerRockProtocol();

export const METERS_PER_DEG_LAT = 110_574;
export const metersPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Relief accentué de 20 % : les altitudes lues sur la carte sont à diviser d'autant. */
export const TERRAIN_EXAGGERATION = 1.2;

export type Base = 'satellite' | 'topo';

/**
 * Rendu « plan des pistes » en hiver : l'image satellite (prise en été) est
 * passée en gris, recouverte d'un manteau blanc d'après l'altitude réelle,
 * ombrée de bleu pour modeler le relief, puis les forêts y sont dessinées en
 * sapins (voir addForests). Masqué sur la carte relief.
 */
export const SNOW_LAYERS = ['snow', 'rock', 'snow-shade', 'forest-trees', 'forest-3d'];

const WINTER_SATELLITE = { 'raster-saturation': -0.85, 'raster-brightness-min': 0.12, 'raster-contrast': 0.1 } as const;
const SUMMER_SATELLITE = { 'raster-saturation': 0, 'raster-brightness-min': 0, 'raster-contrast': 0 } as const;

/** Bascule entre l'hiver (neige, ombres bleues, sapins) et l'image satellite brute. */
export function applyWinter(map: MlMap, winter: boolean) {
  const paint = winter ? WINTER_SATELLITE : SUMMER_SATELLITE;
  map.setPaintProperty('base-satellite', 'raster-saturation', paint['raster-saturation']);
  map.setPaintProperty('base-satellite', 'raster-brightness-min', paint['raster-brightness-min']);
  map.setPaintProperty('base-satellite', 'raster-contrast', paint['raster-contrast']);
  for (const id of SNOW_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', winter ? 'visible' : 'none');
  }
}

/** Motif de sapins sombres en quinconce, comme sur les plans des pistes peints. */
function treePattern(): ImageData {
  const size = 40;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const tree = (x: number, y: number, h: number) => {
    ctx.fillStyle = '#1f3a2c';
    ctx.beginPath();
    ctx.moveTo(x, y - h);
    ctx.lineTo(x + h * 0.38, y);
    ctx.lineTo(x - h * 0.38, y);
    ctx.closePath();
    ctx.fill();
    // Liseré clair côté soleil (lumière venant du nord-ouest, comme l'ombrage).
    ctx.strokeStyle = 'rgba(215, 232, 240, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y - h);
    ctx.lineTo(x - h * 0.38, y);
    ctx.stroke();
  };
  // Sapins serrés, légèrement décalés pour casser la grille.
  const spots: [number, number, number][] = [
    [5, 11, 10], [17, 9, 12], [29, 12, 10], [11, 22, 11], [23, 24, 12], [35, 23, 9],
    [4, 34, 11], [16, 37, 10], [29, 36, 12], [38, 4, 9],
  ];
  spots.forEach(([x, y, h]) => tree(x, y, h));
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Forêts en sapins sur la neige, sous les pistes (`beforeId`). `visible` suit
 * l'interrupteur de la neige au moment où les données arrivent.
 */
export function addForests(map: MlMap, data: GeoJSON.FeatureCollection, visible: boolean, beforeId?: string) {
  map.addImage('trees', treePattern(), { pixelRatio: 2 });
  map.addSource('forests', { type: 'geojson', data });
  const layout = { visibility: visible ? ('visible' as const) : ('none' as const) };
  // Motif au sol pour la vue d'ensemble, effacé de près au profit des sapins 3D (forestTrees.ts).
  map.addLayer(
    {
      id: 'forest-trees',
      type: 'fill',
      source: 'forests',
      layout,
      paint: { 'fill-pattern': 'trees', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13.4, 0.95, 14.2, 0] },
    },
    beforeId,
  );
}

const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];

/** Image satellite ou carte topographique drapée sur le relief réel (Terrain Tiles). */
export const TERRAIN_STYLE: StyleSpecification = {
  version: 8,
  // Polices des noms des pistes et remontées, servies par le site (public/fonts) : Noto Sans,
  // licence SIL OFL. Seuls les alphabets latins, grecs et cyrilliques et la ponctuation sont
  // fournis. Adresse absolue : MapLibre ne résout pas les chemins relatifs.
  glyphs: `${typeof window === 'undefined' ? '' : window.location.origin}/fonts/{fontstack}/{range}.pbf`,
  sources: {
    satellite: {
      type: 'raster',
      // Photographies aériennes de l'IGN (voir src/lib/ignTiles.ts).
      tiles: [IGN_ORTHO_URL],
      tileSize: 256,
      maxzoom: IGN_MAX_ZOOM,
      attribution: IGN_ATTRIBUTION,
    },
    topo: {
      type: 'raster',
      // Plan IGN.
      tiles: [IGN_PLAN_URL],
      tileSize: 256,
      maxzoom: IGN_MAX_ZOOM,
      attribution: IGN_ATTRIBUTION,
    },
    // Altitudes : Terrain Tiles (Mapzen / AWS Open Data), format « terrarium ».
    dem: {
      type: 'raster-dem',
      tiles: DEM_TILES,
      tileSize: 256,
      maxzoom: 15,
      encoding: 'terrarium',
      attribution: 'Relief : Terrain Tiles (Mapzen, AWS Open Data — SRTM, EU-DEM/Copernicus)',
    },
    // Mêmes altitudes pour la neige et l'ombrage : MapLibre recommande une source
    // distincte de celle du relief 3D, pour un rendu plus net.
    'dem-snow': { type: 'raster-dem', tiles: DEM_TILES, tileSize: 256, maxzoom: 15, encoding: 'terrarium' },
    // Roche à nu sur les pentes trop raides pour garder la neige (rockTiles.ts).
    rock: { type: 'raster', tiles: ['rock://{z}/{x}/{y}'], tileSize: 256, minzoom: 10, maxzoom: 17 },
  },
  layers: [
    // Photo d'origine au chargement ; l'hiver s'active à la demande (applyWinter).
    { id: 'base-satellite', type: 'raster', source: 'satellite' },
    { id: 'base-topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
    {
      id: 'snow',
      type: 'color-relief',
      source: 'dem-snow',
      layout: { visibility: 'none' },
      paint: {
        // Neige jusqu'en fond de vallée (plein hiver), de plus en plus pure en montant :
        // au-dessus de 2 000 m, plus rien de l'image d'été ne transparaît.
        'color-relief-color': [
          'interpolate',
          ['linear'],
          ['elevation'],
          400, 'rgba(244, 248, 252, 0.25)',
          800, 'rgba(244, 248, 252, 0.6)',
          1200, 'rgba(246, 250, 253, 0.8)',
          1700, 'rgba(248, 251, 254, 0.92)',
          2100, 'rgba(250, 252, 255, 1)',
        ],
      },
    },
    // Parois et barres rocheuses par-dessus la neige, sous l'ombrage bleuté qui modèle le relief.
    { id: 'rock', type: 'raster', source: 'rock', minzoom: 10, layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 200 } },
    {
      id: 'snow-shade',
      type: 'hillshade',
      source: 'dem-snow',
      layout: { visibility: 'none' },
      paint: {
        // Ombres bleutées et lumière du nord-ouest, comme sur un panorama peint.
        'hillshade-illumination-direction': 315,
        'hillshade-shadow-color': 'rgba(52, 88, 135, 0.75)',
        'hillshade-highlight-color': 'rgba(255, 255, 255, 0.4)',
        'hillshade-accent-color': 'rgba(40, 70, 115, 0.4)',
        'hillshade-exaggeration': 0.8,
      },
    },
  ],
  terrain: { source: 'dem', exaggeration: TERRAIN_EXAGGERATION },
  sky: {
    'sky-color': '#6fb1e8',
    'horizon-color': '#d9ecfa',
    'fog-color': '#e4f1fb',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.9,
  },
};

/** Plan des pistes (mètres projetés autour de son centre) → GeoJSON en longitude / latitude. */
export function pisteGeoJson(map: StationPisteMap) {
  const { lat: cLat, lng: cLng } = map.center;
  const mPerDegLng = metersPerDegLng(cLat);
  const toLngLat = (p: { x: number; y: number }) => [cLng + p.x / mPerDegLng, cLat - p.y / METERS_PER_DEG_LAT];
  return {
    pistes: {
      type: 'FeatureCollection' as const,
      features: map.pistes.map((p) => ({
        type: 'Feature' as const,
        properties: { difficulty: p.difficulty, name: p.name ?? '' },
        geometry: { type: 'LineString' as const, coordinates: p.points.map(toLngLat) },
      })),
    },
    lifts: {
      type: 'FeatureCollection' as const,
      features: map.lifts
        .filter((l) => isSkierLift(l.liftType))
        .map((l) => ({
          type: 'Feature' as const,
          properties: { name: l.name ?? '', liftType: l.liftType, length: Math.round(l.length) },
          geometry: { type: 'LineString' as const, coordinates: l.points.map(toLngLat) },
        })),
    },
    peaks: map.peaks.map((p) => {
      const [lng, lat] = toLngLat(p.point);
      return { id: p.id, name: p.name, elevation: p.elevation, lng, lat };
    }),
  };
}

// Teintes de façades alpines (bois, pierre, crépis), choisies de façon stable
// d'après la forme du bâtiment.
const FACADE_COLORS = ['#c9a27e', '#b98b62', '#d8c3a5', '#e8dcc6', '#a9a39a', '#cfc6b8', '#d9b48f', '#bfa58a'];

export function facadeColor(ring: [number, number][]): string {
  const seed = Math.abs(Math.round((ring[0][0] + ring[0][1]) * 1e5) + ring.length);
  return FACADE_COLORS[seed % FACADE_COLORS.length];
}

export function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export interface PlacePopup {
  name: string;
  /** Ligne de précision sous le nom (« 🍽️ Restaurant · savoyard »). */
  kind: string;
  openingHours?: string;
  phone?: string;
  website?: string;
}

/** Contenu de la bulle d'un lieu, construit sans innerHTML : les textes viennent d'OpenStreetMap. */
export function placePopupContent(place: PlacePopup, action?: { label: string; onClick: () => void }): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-sm';
  const title = document.createElement('div');
  title.className = 'font-semibold text-[#1a1a20]';
  title.textContent = place.name;
  const kind = document.createElement('div');
  kind.className = 'text-xs text-gray-500';
  kind.textContent = place.kind;
  root.append(title, kind);
  if (place.openingHours) {
    const hours = document.createElement('div');
    hours.className = 'mt-1 text-xs text-gray-600';
    hours.textContent = `Horaires : ${place.openingHours}`;
    root.append(hours);
  }
  if (place.phone) {
    const phone = document.createElement('a');
    phone.className = 'mt-1 block text-xs text-[#12324a] underline';
    phone.href = `tel:${place.phone.replace(/[^\d+]/g, '')}`;
    phone.textContent = place.phone;
    root.append(phone);
  }
  if (place.website && /^https?:\/\//i.test(place.website)) {
    const site = document.createElement('a');
    site.className = 'mt-1 block text-xs text-[#12324a] underline';
    site.href = place.website;
    site.target = '_blank';
    site.rel = 'noopener noreferrer';
    site.textContent = 'Site web';
    root.append(site);
  }
  // Bouton d'action (« Y aller » sur la carte des 3 Vallées).
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mt-2 w-full rounded-lg bg-[#2f5c7d] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#244a66]';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    root.append(btn);
  }
  return root;
}
