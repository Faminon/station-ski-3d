'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FullscreenControl, GeolocateControl, LngLatBounds, Map as MlMap, Marker, NavigationControl, Popup, ScaleControl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ArrowLeft, Box, Cable, Check, ExternalLink, FlaskConical, Layers, Loader2, LocateFixed, Map as MapIcon, Maximize2, MousePointer2, Navigation, RotateCw, Search, Share2, Snowflake, X } from 'lucide-react';
import { DIFFICULTY_LABELS, PISTE_COLORS, type PisteDifficulty, type StationPisteMap } from '@/lib/apis/overpass';
import type { PisteStats } from '@/lib/pisteStats';
import { applyCorrections, applyPoiCorrections, type DomainCorrections } from '@/lib/domainCorrections';
import { DOMAIN_POI_CATEGORIES, type DomainPoi, type DomainPoiCategoryId, type DomainPois } from '@/lib/domainPois';
import { DIFFICULTY_SINGULAR, LIFT_LABELS, type DomainVillage, type SkiDomainConfig } from '@/lib/skiDomains';
import { SEARCH_SITE_URL } from '@/lib/searchSite';
import type { Village3d } from '@/lib/village3d';
import RouteCard, { NavigationBar, ROUTE_LIFT_COLOR, ROUTE_WALK_COLOR, type RouteGoal, type RouteStatus } from './RouteCard';
import { loadTerrain } from './terrainSampler';
import { siteOrigin } from '@/lib/offlinePack';
import { buildSkiGraph, lineLength, planRoute, trimRoute, type ClosedLines, type RouteResult, type RouteTarget, type SkiGraph, type SkiLevel } from '@/lib/skiRouting';
import { PARK_COLORS, parkZoneFeatures } from './parkZones';
import { formatDistance, nearestLine, nearestPoint, type NamedLine, type Nearest } from './nearby';
import { PARK_FEATURES_LAYER, addParkFeatures } from './parkFeatures';
import { addForestTrees, largestForestCenter, type ForestController } from './forestTrees';
import { installPerfProbe } from './perfProbe';
import { installAdaptiveQuality } from './adaptiveQuality';
import { installFrameLimiter } from './frameLimiter';
import { tuneMapPerformance } from './mapPerformance';
import LivePanel, { AvalancheRiskIcon, LIVE_CLOSED_OPACITY, RISK_LABELS } from './LivePanel';
import { POI_ICONS, SEARCH_ICONS } from './panelIcons';
import { useLiveConditions } from './useLiveConditions';
import { useMapGestures } from './useMapGestures';
import { SIM_SPEEDUP, SIM_TICK_MS, headingTo, pointAhead, simPath } from './routeGeometry';
import type { LiveConditions, LiveItemState } from '@/lib/live/types';
import { BUILDINGS_LAYER, addPlaceBuildings, mountainPlaces, placeClearings, type BuiltArea } from './mountainBuildings';
import { LIFT_3D_LAYERS, addLifts3d, type LiftsController } from '@/components/station/liftAnimation';
import { type Base, addForests, applyWinter, TERRAIN_EXAGGERATION, TERRAIN_STYLE, facadeColor, pisteGeoJson, supportsWebGL } from '@/components/station/map3d';
import { PlaceCard, TrackCard, openReactPopup } from './MapPopup';

/**
 * Carte 3D d'un domaine skiable relié, en plein écran : relief réel, toutes les
 * pistes et remontées du domaine relié, sommets, villages et lieux utiles au
 * skieur (restaurants, points de vue, snowparks, toilettes…), à choisir dans
 * le panneau. Les bâtiments des stations ne sont chargés qu'en s'approchant
 * d'un village.
 */

const DIFFICULTIES: PisteDifficulty[] = ['green', 'blue', 'red', 'black'];

/** Les sommets secondaires n'apparaissent qu'à partir de ce zoom, pour ne pas charger la vue d'ensemble. */
const MINOR_PEAKS_ZOOM = 12.2;
const MAJOR_PEAK_M = 2900;
/** Les bâtiments (plusieurs centaines de Ko par station) ne sont chargés qu'à partir de ce zoom. */
const BUILDINGS_ZOOM = 13;
/** Largeur occupée par le panneau sur grand écran (panneau + marges). */
const PANEL_SPACE = 372;

/** Inclinaison de la vue d'ensemble ; son cap dépend du domaine (overviewBearing). */
const OVERVIEW_PITCH = 52;
const isWide = () => window.innerWidth >= 640;

/** Filtre qui ne retient aucun tracé : surbrillance éteinte. */
const NO_FEATURE: FilterSpecification = ['==', ['get', 'name'], '\u0000'];

const CATEGORY = new Map(DOMAIN_POI_CATEGORIES.map((c) => [c.id, c]));
const POI_GROUPS = [
  { title: 'Sur les pistes', categories: DOMAIN_POI_CATEGORIES.filter((c) => c.defaultOn) },
  { title: 'Dans les stations', categories: DOMAIN_POI_CATEGORIES.filter((c) => !c.defaultOn) },
];
/** Nombre de résultats listés sous le champ de recherche. */
const SEARCH_RESULTS = 40;

/** Comparaison sans accents ni majuscules. */
const normalize = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Pastille d'une catégorie de lieux : émoji sur disque blanc cerclé de sa couleur. */
function poiIcon(emoji: string, color: string): ImageData {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.font = '30px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + 2);
  return ctx.getImageData(0, 0, size, size);
}

/** Au-delà de cette distance de la piste la plus proche, on est « hors du domaine ». */
const OFF_DOMAIN_M = 2000;
/** Pastilles des lieux masquées en vue d'ensemble : elles couvriraient tout le domaine. */
const POIS_MIN_ZOOM = 11.5;
const LABEL_FONT = ['Noto Sans Bold'];

/** Caméra d'un lien partagé (`#vue=zoom/lat/lng/cap/inclinaison`, format de MapLibre), ou null. */
function parseSharedView(hash: string) {
  const m = hash.match(/[#&]vue=([^&]+)/);
  const [zoom, lat, lng, bearing = 0, pitch = 0] = (m?.[1].split('/') ?? []).map(Number);
  if (![zoom, lat, lng, bearing, pitch].every(Number.isFinite)) return null;
  return { zoom, center: [lng, lat] as [number, number], bearing, pitch };
}

/** Téléskis et fils neige (« tire-fesses ») : dessinés en trait plein à perches, comme sur les plans des pistes. */
const DRAG_LIFT_TYPES = ['platter', 'drag_lift', 't-bar', 'j-bar', 'rope_tow'];
const IS_DRAG: FilterSpecification = ['in', ['get', 'liftType'], ['literal', DRAG_LIFT_TYPES]];
const NOT_DRAG: FilterSpecification = ['!', IS_DRAG];

/** Motif d'une perche de téléski : tige perpendiculaire au câble, terminée par l'assiette. */
/** Croix rouge cerclée de blanc posée sur une piste fermée. */
function closedCrossIcon(): ImageData {
  const size = 40;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(20, 20, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e03131';
  ctx.beginPath();
  ctx.arc(20, 20, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(13.5, 13.5);
  ctx.lineTo(26.5, 26.5);
  ctx.moveTo(26.5, 13.5);
  ctx.lineTo(13.5, 26.5);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

/** Tronçons trop courts pour porter une croix (liaisons, bouts de piste découpés par OSM). */
const CLOSED_CROSS_MIN_LENGTH = 150;
const LONG_ENOUGH: ExpressionSpecification = ['>=', ['get', 'length'], CLOSED_CROSS_MIN_LENGTH];

function dragTickIcon(): ImageData {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#1a1a20';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(12, 12);
  ctx.lineTo(12, 21);
  ctx.stroke();
  ctx.fillStyle = '#1a1a20';
  ctx.beginPath();
  ctx.arc(12, 20, 3, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** Types proposés par la recherche (« je cherche un restaurant, une remontée… »). */
type SearchKind = 'all' | 'restaurant' | 'lift' | 'piste' | 'toilets' | 'hut' | 'village';
const SEARCH_KINDS: { id: SearchKind; label: string; emoji: string }[] = [
  { id: 'all', label: 'Tout', emoji: '🔎' },
  { id: 'restaurant', label: 'Restaurants', emoji: '🍽️' },
  { id: 'lift', label: 'Remontées', emoji: '🚡' },
  { id: 'piste', label: 'Pistes', emoji: '⛷️' },
  { id: 'toilets', label: 'Toilettes', emoji: '🚻' },
  { id: 'hut', label: 'Refuges', emoji: '🛖' },
  { id: 'village', label: 'Stations', emoji: '🏔️' },
];

/** Types de recherche qui sont des lieux : la carte n'affiche alors que ceux-là. */
const SEARCH_KIND_POIS: Partial<Record<SearchKind, DomainPoiCategoryId>> = { restaurant: 'restaurant', hut: 'hut', toilets: 'toilets' };

/** Un résultat de recherche : lieu, remontée, piste ou station. */
interface SearchEntry {
  id: string;
  /** 'other' : lieu sans filtre dédié (bar, boutique…), proposé avec « Tout ». */
  kind: Exclude<SearchKind, 'all'> | 'other';
  name: string;
  sub: string;
  emoji: string;
  /** Pastille de couleur (pistes). */
  color?: string;
  lng: number;
  lat: number;
  poi?: DomainPoi;
  /** Tracés de la piste (pour viser son haut) ou nom de la remontée à mettre en évidence. */
  lines?: number[][][];
  liftName?: string;
  pisteKey?: { name: string; difficulty: string };
  village?: { village: DomainVillage; bearing: number };
}

const ROUTE_PREVIEW_COLOR: unknown = ['match', ['get', 'kind'], 'lift', '#7048e8', 'walk', '#868e96', '#ff6b00'];
/** Calques estompés pendant le guidage : seul l'itinéraire reste net. [calque, propriété, valeur estompée] */
const FADED_WHILE_GUIDING: [string, string, unknown][] = [
  ['pistes', 'line-opacity', 0.35],
  ['pistes', 'line-color', '#9aa1a8'],
  ['pistes-casing', 'line-opacity', 0.2],
  ['lifts', 'line-opacity', 0.25],
  ['lifts-drag', 'line-opacity', 0.25],
  ['lifts-drag-ticks', 'icon-opacity', 0.25],
  ['lifts-casing', 'line-opacity', 0.1],
  ['piste-labels', 'text-opacity', 0.3],
  ['lift-labels', 'text-opacity', 0.3],
  ['pois', 'icon-opacity', 0.5],
  ['roads', 'line-opacity', 0.35],
  ['roads-casing', 'line-opacity', 0.2],
  ['road-labels', 'text-opacity', 0.3],
  // Vus de près en caméra basse, câbles et pylônes 3D bouchent la vue : masqués pendant le guidage.
  ['lift-structures', 'fill-extrusion-opacity', 0],
  ['lift-cabins', 'fill-extrusion-opacity', 0],
  ['park-features', 'fill-extrusion-opacity', 0.3],
];
/** Lecture et écriture de propriétés de calque nommées dynamiquement (types MapLibre trop stricts ici). */
const getPaint = (map: MlMap, id: string, prop: string): unknown => map.getPaintProperty(id, prop as never);
const setPaint = (map: MlMap, id: string, prop: string, value: unknown) => map.setPaintProperty(id, prop as never, value as never);

/** Ce que la fiche « Ma position » dit du skieur localisé. */
interface Here {
  lng: number;
  lat: number;
  /** Précision du GPS, en mètres. */
  accuracy: number;
  altitude: number | null;
  /** Distance à la piste la plus proche quand on est loin du domaine. */
  offDomain: number | null;
  piste: Nearest<NamedLine> | null;
  lift: Nearest<NamedLine> | null;
  restaurant: Nearest<DomainPoi> | null;
}

type GeoStatus = 'off' | 'searching' | 'on' | 'out' | 'denied' | 'error';

interface Hover {
  color: string;
  title: string;
  detail: string;
  /** État en direct (« Ouverte · Damée »), et s'il est ouvert. */
  live?: { text: string; open: boolean };
}

// ---- État en direct des tracés ------------------------------------------------------------
// Chaque piste et remontée porte un « feature-state » `live` ('open', 'closed', 'out', ou rien
// sans donnée) : les styles en tiennent compte sans recharger les tracés ni ajouter de calque.
const LIVE_STATE: ExpressionSpecification = ['to-string', ['feature-state', 'live']];
const LIVE_SHUT: ExpressionSpecification = ['match', LIVE_STATE, ['closed', 'out'], true, false];
/** Valeur `shut` pour un tracé fermé ou hors saison, `normal` sinon. */
const whenShut = (shut: number, normal: number): ExpressionSpecification => ['case', LIVE_SHUT, shut, normal];

function liveText(state: LiveItemState | undefined): Hover['live'] {
  if (!state) return undefined;
  const parts = [state.label, state.grooming, state.hours, state.message].filter(Boolean);
  return { text: parts.join(' · '), open: state.status === 'open' };
}

/** Étiquette d'un village : bouton qui amène la vue sur lui (texte posé en textContent). */
function villageElement(village: DomainVillage, onClick: () => void): HTMLElement {
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'group flex cursor-pointer flex-col items-center';
  const tag = document.createElement('span');
  tag.className =
    'rounded-full border-2 border-white bg-[#1f3b57] px-2.5 py-1 text-[11px] font-semibold leading-none text-white shadow-lg transition group-hover:bg-accent whitespace-nowrap';
  tag.textContent = village.name;
  const stem = document.createElement('span');
  stem.className = 'h-4 w-0.5 bg-white/90';
  const dot = document.createElement('span');
  dot.className = '-mt-0.5 h-2 w-2 rounded-full border border-white bg-accent';
  root.append(tag, stem, dot);
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return root;
}

/** Étiquette d'un sommet : nom et altitude, sans interaction. */
function peakElement(name: string, elevation?: number): HTMLElement {
  const root = document.createElement('div');
  root.className = 'pointer-events-none flex flex-col items-center text-center';
  root.style.textShadow = '0 1px 3px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9)';
  const label = document.createElement('span');
  label.className = 'text-[11px] font-semibold leading-tight text-white whitespace-nowrap';
  label.textContent = name;
  root.append(label);
  if (elevation) {
    const alt = document.createElement('span');
    alt.className = 'text-[10px] leading-tight text-white/85';
    alt.textContent = `${elevation.toLocaleString('fr-FR')} m`;
    root.append(alt);
  }
  const mark = document.createElement('span');
  mark.className = 'text-[9px] leading-none text-white';
  mark.textContent = '▲';
  root.append(mark);
  return root;
}

/**
 * Routes ouvertes aux voitures, dessinées comme sur les plans des pistes : trait gris-brun
 * sur liseré clair, lisible sur la neige comme sur la photo. Sous les pistes et les remontées.
 */
function addRoads(map: MlMap, data: GeoJSON.FeatureCollection) {
  map.addSource('roads', { type: 'geojson', data });
  const width = (major: number[], road: number[], street: number[]) =>
    ['interpolate', ['exponential', 1.6], ['zoom'], 10, ['match', ['get', 'cls'], 'major', major[0], 'road', road[0], street[0]], 14, ['match', ['get', 'cls'], 'major', major[1], 'road', road[1], street[1]], 17, ['match', ['get', 'cls'], 'major', major[2], 'road', road[2], street[2]]] as unknown as number;
  const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
  // Rues : à partir du zoom des villages seulement.
  const filter: FilterSpecification = ['any', ['!=', ['get', 'cls'], 'street'], ['>=', ['zoom'], 12.5]];
  map.addLayer(
    {
      id: 'roads-casing',
      type: 'line',
      source: 'roads',
      filter,
      layout: round,
      paint: { 'line-color': '#fdfbf7', 'line-opacity': 0.85, 'line-width': width([2.4, 5.5, 13], [1.4, 4, 10], [0.8, 3, 8]) },
    },
    'pistes-casing',
  );
  map.addLayer(
    {
      id: 'roads',
      type: 'line',
      source: 'roads',
      filter,
      layout: round,
      paint: {
        'line-color': ['match', ['get', 'cls'], 'major', '#7c6a58', 'road', '#8f8478', '#a39d95'],
        'line-width': width([1.2, 3, 8], [0.7, 2.2, 6], [0.4, 1.6, 5]),
      },
    },
    'pistes-casing',
  );
  // Numéro des grandes routes (D902…), le long du tracé.
  map.addLayer(
    {
      id: 'road-labels',
      type: 'symbol',
      source: 'roads',
      minzoom: 11.5,
      filter: ['has', 'ref'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'text-field': ['get', 'ref'],
        'text-font': LABEL_FONT,
        'text-size': 10,
        'text-letter-spacing': 0.05,
      },
      paint: { 'text-color': '#6b5b4b', 'text-halo-color': '#fdfbf7', 'text-halo-width': 1.6 },
    },
    'pistes-casing',
  );
}

/** Étapes de l'écran de chargement, dans l'ordre où elles se terminent d'habitude. */
const BOOT_STEPS = [
  { id: 'relief', label: 'Relief et photos aériennes' },
  { id: 'pistes', label: 'Pistes et remontées' },
  { id: 'decor', label: 'Forêts et routes' },
  { id: 'places', label: 'Restaurants, lieux et snowparks' },
  { id: 'render', label: 'Affichage en 3D' },
] as const;
type BootStep = (typeof BOOT_STEPS)[number]['id'];

/** Onglets du panneau (quand le domaine a des conditions en direct). */
type PanelTab = 'explore' | 'conditions';
const PANEL_TABS: [PanelTab, string][] = [
  ['explore', 'Explorer'],
  ['conditions', 'Conditions'],
];

/** Interrupteur visuel d'une ligne à bascule (le bouton porte role="switch"). */
function SwitchKnob({ on }: { on: boolean }) {
  return (
    <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-primary' : 'bg-winter-200'}`} aria-hidden>
      <span className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${on ? 'translate-x-5' : 'translate-x-1'}`} />
    </span>
  );
}

export default function Domain3DViewer({
  domain,
  stats,
  villageIds,
  builtAreas,
  embedded = false,
}: {
  /** Domaine affiché : nom, villages, fichiers de données, vue de départ. */
  domain: SkiDomainConfig;
  stats: PisteStats | null;
  /** Stations dont les bâtiments du village sont fournis (public/data/villages/<id>.json). */
  villageIds: string[];
  /** Villages dont les bâtiments réels sont chargés : pas de chalet dessiné pour leurs restaurants. */
  builtAreas: BuiltArea[];
  /** Carte intégrée au site d'une station (iframe) : les liens vers AltiStay s'ouvrent dans un nouvel onglet. */
  embedded?: boolean;
}) {
  useMapGestures();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const boundsRef = useRef<LngLatBounds | null>(null);
  const altitudeRef = useRef<HTMLSpanElement>(null);
  const spinRef = useRef<number | null>(null);
  const buildingsRef = useRef<'idle' | 'loading' | 'done'>('idle');

  // Composant chargé uniquement côté navigateur (ssr: false) : `document` et `window` existent ici.
  const [webglOk] = useState(supportsWebGL);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error' | 'nowebgl'>(webglOk ? 'loading' : 'nowebgl');
  /** Étapes de chargement terminées : l'écran d'accueil reste affiché jusqu'à la dernière. */
  const [boot, setBoot] = useState<BootStep[]>([]);
  const [base, setBase] = useState<Base>('satellite');
  const [enabled, setEnabled] = useState<Set<PisteDifficulty>>(() => new Set(DIFFICULTIES));
  const [showLifts, setShowLifts] = useState(true);
  const liftsRef = useRef<LiftsController | null>(null);
  /** Manteau neigeux sur l'image satellite (option du panneau). */
  // Neige par défaut, comme sur un plan des pistes ; la photo d'été reste à un clic.
  const [snow, setSnow] = useState(true);
  const snowRef = useRef(snow);
  const baseRef = useRef(base);
  const [spinning, setSpinning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(isWide);
  const [hover, setHover] = useState<Hover | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>('off');
  const [here, setHere] = useState<Here | null>(null);
  /** Message bref en bas de l'écran (lien copié, localisation refusée…). */
  const [notice, setNotice] = useState<string | null>(null);
  const geolocateRef = useRef<GeolocateControl | null>(null);
  const goToRef = useRef<((goal: RouteGoal) => void) | null>(null);
  /** Bulle d'une piste ou d'une remontée cliquée (créée dans l'effet de la carte, lit l'état à jour). */
  const openTrackRef = useRef<((f: { layer: 'pistes' | 'lifts'; properties: Record<string, unknown> }, at: [number, number]) => void) | null>(null);
  // Itinéraire à ski.
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeGoal, setRouteGoal] = useState<RouteGoal | null>(null);
  const [routeLevel, setRouteLevel] = useState<SkiLevel>('all');
  /** Départ choisi sur la carte ; sinon, la position GPS. */
  const [pickedStart, setPickedStart] = useState<{ lng: number; lat: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [routeStatus, setRouteStatus] = useState<RouteStatus>('idle');
  const [route, setRoute] = useState<RouteResult | null>(null);
  const graphRef = useRef<Promise<SkiGraph> | null>(null);
  /** Dernier itinéraire cadré : la vue n'est recadrée que si la destination change, pas à chaque position GPS. */
  const framedRef = useRef('');
  /** Guidage lancé : la carte suit le skieur et l'itinéraire se recalcule quand il avance. */
  const [navigating, setNavigating] = useState(false);
  const navigatingRef = useRef(false);
  /** Trajet simulé : une fausse position parcourt l'itinéraire, pour essayer le guidage. */
  const [simulating, setSimulating] = useState(false);
  const simulatingRef = useRef(false);
  const simPathRef = useRef<{ lng: number; lat: number; speed: number }[]>([]);
  const simRouteName = useRef('');
  /** Itinéraire suivi par la simulation (figé au lancement) et distance déjà parcourue. */
  const [simRoute, setSimRoute] = useState<RouteResult | null>(null);
  const [simDistance, setSimDistance] = useState(0);
  const describeRef = useRef<((c: GeolocationCoordinates) => Here) | null>(null);
  /** Valeurs d'origine des calques estompés pendant le guidage. */
  const fadedRef = useRef(new Map<string, unknown>());
  // Vue partagée par lien (#vue=zoom/lat/lng/cap/inclinaison), lue une seule fois : MapLibre
  // efface ce paramètre quand une carte est détruite (remontage du composant en développement).
  const [sharedView] = useState(() => parseSharedView(window.location.hash));
  const linesRef = useRef<{ pistes: NamedLine[]; lifts: NamedLine[] }>({ pistes: [], lifts: [] });
  // Conditions en direct (src/lib/live) : lues par le survol, posées sur les tracés par setFeatureState.
  // Jour de pleine saison simulé : ?demo=saison dans l'adresse, ou le bouton de l'onglet Conditions.
  const [demo, setDemo] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'saison');
  const live = useLiveConditions(domain.slug, !!domain.live && webglOk, demo);
  const toggleDemo = () => {
    const next = !demo;
    setDemo(next);
    // Gardé dans l'adresse (lien partageable, rechargement), sans toucher à la vue (#vue=…).
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('demo', 'saison');
    else url.searchParams.delete('demo');
    window.history.replaceState(window.history.state, '', url);
  };
  const liveRef = useRef<LiveConditions | null>(null);
  const liveIdsRef = useRef<{ pistes: Map<string, string | number | undefined>; lifts: Map<string, string | number | undefined> } | null>(null);
  /** Dernier état posé par tracé (« pistes|12 » → 'open') : seuls les changements sont envoyés à MapLibre. */
  const liveAppliedRef = useRef(new Map<string, string>());
  const [pois, setPois] = useState<DomainPoi[]>([]);
  const [enabledPois, setEnabledPois] = useState<Set<DomainPoiCategoryId>>(
    () => new Set(DOMAIN_POI_CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id)),
  );
  const [query, setQuery] = useState('');
  /** Onglet du panneau : exploration de la carte ou conditions en direct. */
  const [panelTab, setPanelTab] = useState<PanelTab>('explore');
  const [searchKind, setSearchKind] = useState<SearchKind>('all');
  /** Pastilles et bâtiments des lieux ajoutés à la carte (après les données, chargées plus tôt). */
  const [poiLayersReady, setPoiLayersReady] = useState(false);
  /** Pistes et remontées du domaine, pour la recherche (copie d'état de linesRef). */
  const [lines, setLines] = useState<{ pistes: NamedLine[]; lifts: NamedLine[] }>({ pistes: [], lifts: [] });
  const popupRef = useRef<Popup | null>(null);
  const poisRef = useRef<DomainPoi[]>([]);
  const panelOpenRef = useRef(panelOpen);
  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);

  /** Marges de cadrage : la vue utile commence à droite du panneau quand il est ouvert. */
  const padding = () => ({ top: 70, bottom: 50, right: 40, left: panelOpenRef.current && isWide() ? PANEL_SPACE : 40 });

  /**
   * Cadre une emprise en vue inclinée. `cameraForBounds` raisonne vue du dessus :
   * incliné, le premier plan déborde. On part donc de son résultat, puis on
   * recule et recentre jusqu'à ce que l'emprise projetée à l'écran tienne dans
   * la zone utile — essais faits dans la même passe, sans rien afficher.
   */
  /** Décalage du centre vers la droite du panneau, sans marge persistante sur la carte. */
  const panelOffset = (): [number, number] => [(padding().left - 40) / 2, 0];

  const flyToBounds = (bounds: LngLatBounds, bearing: number, pitch: number, animate = true, maxZoom = Infinity) => {
    const map = mapRef.current;
    if (!map) return;
    const pad = padding();
    const first = map.cameraForBounds(bounds, { bearing, padding: pad });
    if (!first?.center || first.zoom === undefined) return;
    const saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    const { clientWidth, clientHeight } = map.getContainer();
    const box = { left: pad.left, right: clientWidth - pad.right, top: pad.top, bottom: clientHeight - pad.bottom };
    const corners = [bounds.getSouthWest(), bounds.getSouthEast(), bounds.getNorthEast(), bounds.getNorthWest()];
    let center = first.center;
    let zoom = first.zoom + 0.6;
    for (let i = 0; i < 30; i++) {
      map.jumpTo({ center, zoom, bearing, pitch });
      const pts = corners.map((c) => map.project(c));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const dx = (minX + maxX) / 2 - (box.left + box.right) / 2;
      const dy = (minY + maxY) / 2 - (box.top + box.bottom) / 2;
      const fits = maxX - minX <= box.right - box.left && maxY - minY <= box.bottom - box.top;
      if (fits && Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
      const at = map.project(center);
      center = map.unproject([at.x + dx, at.y + dy]);
      if (!fits) zoom -= 0.12;
    }
    if (!animate) return;
    map.jumpTo(saved);
    map.flyTo({ center, zoom: Math.min(zoom, maxZoom), bearing, pitch, duration: 2400 });
  };

  const showOverview = (animate = true) => {
    setSpinning(false);
    if (boundsRef.current) flyToBounds(boundsRef.current, domain.overviewBearing, OVERVIEW_PITCH, animate);
  };

  const showVillage = (village: DomainVillage, bearing: number) => {
    setSpinning(false);
    if (!isWide()) setPanelOpen(false);
    mapRef.current?.flyTo({ center: [village.lng, village.lat], zoom: 14.6, pitch: 64, bearing, duration: 2400, offset: panelOffset() });
  };

  const openPoi = (poi: DomainPoi) => {
    const map = mapRef.current;
    if (!map) return;
    const category = CATEGORY.get(poi.category)!;
    popupRef.current?.remove();
    popupRef.current = openReactPopup(map, [poi.lng, poi.lat], (close) => (
      <PlaceCard
        name={poi.name}
        kind={poi.name === poi.kind ? category.label : poi.kind}
        color={category.color}
        icon={POI_ICONS[poi.category]}
        openingHours={poi.openingHours}
        phone={poi.phone}
        website={poi.website}
        onGo={() => goToRef.current?.({ kind: 'poi', poi })}
        onClose={close}
      />
    ));
  };

  /** Depuis la recherche : affiche la catégorie du lieu, amène la vue dessus et ouvre sa bulle. */
  const showPoi = (poi: DomainPoi) => {
    setSpinning(false);
    if (!isWide()) setPanelOpen(false);
    setEnabledPois((prev) => (prev.has(poi.category) ? prev : new Set(prev).add(poi.category)));
    mapRef.current?.flyTo({ center: [poi.lng, poi.lat], zoom: 15.6, pitch: 62, duration: 2400, offset: panelOffset() });
    openPoi(poi);
  };

  // ---- Création de la carte et chargement du domaine ---------------------------
  useEffect(() => {
    if (!containerRef.current || !webglOk) return;
    let cancelled = false;
    const map = new MlMap({
      container: containerRef.current,
      style: TERRAIN_STYLE,
      center: domain.center,
      zoom: 10.8,
      pitch: OVERVIEW_PITCH,
      bearing: domain.overviewBearing,
      ...sharedView,
      // 70° au plus : au-delà, la vue file jusqu'à l'horizon et charge des centaines de tuiles lointaines.
      maxPitch: 70,
      minZoom: 9,
      // Écrans très denses (téléphones ×3) : rendu plafonné à ×2, soit plus de deux fois moins de pixels à dessiner.
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      locale: {
        'GeolocateControl.FindMyLocation': 'Me localiser',
        'GeolocateControl.LocationNotAvailable': 'Localisation indisponible',
        'FullscreenControl.Enter': 'Plein écran',
        'FullscreenControl.Exit': 'Quitter le plein écran',
        'NavigationControl.ZoomIn': 'Zoomer',
        'NavigationControl.ZoomOut': 'Dézoomer',
        'NavigationControl.ResetBearing': 'Revenir au nord',
      },
      // La vue courante est inscrite dans l'adresse : le lien « Partager » la reproduit.
      hash: 'vue',
      // Le domaine tient dans ce cadre : inutile de laisser partir la vue au bout des Alpes.
      maxBounds: [
        [domain.center[0] - 0.7, domain.center[1] - 0.5],
        [domain.center[0] + 0.7, domain.center[1] + 0.5],
      ],
      attributionControl: { compact: true, customAttribution: 'Pistes, remontées, sommets, lieux et bâtiments © contributeurs OpenStreetMap (ODbL)' },
    });
    mapRef.current = map;
    // Promesse créée tout de suite : si les données arrivent après l'événement,
    // attendre un nouvel événement de style bloquerait la vue.
    const styleReady = new Promise<void>((resolve) => map.once('style.load', () => resolve()));
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new FullscreenControl(), 'top-right');
    const geolocate = new GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 15000 },
      trackUserLocation: true,
      showAccuracyCircle: true,
      fitBoundsOptions: { maxZoom: 15.5 },
    });
    map.addControl(geolocate, 'top-right');
    geolocateRef.current = geolocate;
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');

    /** Altitude, piste, remontée et restaurant les plus proches d'une position GPS. */
    const describe = (c: GeolocationCoordinates): Here => {
      const { pistes, lifts } = linesRef.current;
      const any = nearestLine(c.longitude, c.latitude, pistes, false);
      const offDomain = any && any.distance > OFF_DOMAIN_M ? any.distance : null;
      const ground = map.queryTerrainElevation([c.longitude, c.latitude]);
      return {
        lng: c.longitude,
        lat: c.latitude,
        accuracy: c.accuracy,
        altitude: c.altitude ?? (ground === null ? null : ground / TERRAIN_EXAGGERATION),
        offDomain,
        piste: offDomain ? null : nearestLine(c.longitude, c.latitude, pistes),
        lift: offDomain ? null : nearestLine(c.longitude, c.latitude, lifts),
        restaurant: offDomain ? null : nearestPoint(c.longitude, c.latitude, poisRef.current.filter((p) => p.category === 'restaurant' || p.category === 'hut')),
      };
    };
    describeRef.current = describe;
    geolocate.on('trackuserlocationstart', () => setGeoStatus((s) => (s === 'on' ? s : 'searching')));
    geolocate.on('geolocate', (e) => {
      setGeoStatus('on');
      setHere(describe(e.coords));
    });
    geolocate.on('outofmaxbounds', () => {
      setGeoStatus('out');
      setHere(null);
      setNotice(`Vous êtes en dehors de ${domain.name} : la carte reste sur le domaine.`);
    });
    geolocate.on('error', (e) => {
      setGeoStatus(e.code === 1 ? 'denied' : 'error');
      setNotice(
        e.code === 1
          ? 'Localisation refusée : autorisez-la dans votre navigateur pour vous situer sur les pistes.'
          : 'Position introuvable pour le moment. Réessayez à découvert.',
      );
    });
    // Crédits repliés au départ (bouton « i ») : dépliés, ils barrent le bas de la carte.
    const credits = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    credits?.classList.remove('maplibregl-compact-show');
    credits?.removeAttribute('open');

    const markers: Marker[] = [];
    let stopBuildings: (() => void) | undefined;
    let stopPerfProbe: (() => void) | undefined;
    // Sapins 3D : pistes, remontées et routes restent dégagées (données arrivées dans n'importe quel ordre).
    let forestTrees: ForestController | undefined;
    // Qualité adaptative : la carte s'allège d'elle-même si l'appareil ne suit pas en mouvement.
    // Réglages de MapLibre (drapage sur le relief, tuiles lointaines, ordre des calques) : voir mapPerformance.ts.
    const stopTuning = tuneMapPerformance(map);
    // Cadence régulière : une image tous les N rafraîchissements de l'écran, proche de 40 par seconde.
    const limiter = installFrameLimiter(map);
    const quality = installAdaptiveQuality(map, limiter, { setTreeDensity: (d) => forestTrees?.setDensity(d) });
    let parkReady: Promise<void> = Promise.resolve();
    const markBoot = (step: BootStep) => !cancelled && setBoot((prev) => (prev.includes(step) ? prev : [...prev, step]));
    // Filet de sécurité : jamais plus de 30 s d'écran de chargement, même si une donnée n'arrive pas.
    const bootTimeout = setTimeout(() => !cancelled && setBoot(BOOT_STEPS.map((s) => s.id)), 30_000);
    let roadLines: number[][][] = [];
    let buildingClearings: ReturnType<typeof placeClearings> = [];
    const syncClearings = () =>
      forestTrees?.setClearings([
        ...buildingClearings,
        ...linesRef.current.pistes.map((l) => ({ coordinates: l.coordinates, halfWidth: 16 })),
        ...linesRef.current.lifts.map((l) => ({ coordinates: l.coordinates, halfWidth: 7 })),
        ...roadLines.map((coordinates) => ({ coordinates, halfWidth: 7 })),
      ]);
    const minorPeaks: HTMLElement[] = [];
    // Appelé à chaque image du zoom : on ne touche aux pastilles qu'au passage du seuil.
    let peaksShown: boolean | undefined;
    const syncPeaks = () => {
      const show = map.getZoom() >= MINOR_PEAKS_ZOOM;
      if (show === peaksShown) return;
      peaksShown = show;
      minorPeaks.forEach((el) => (el.style.display = show ? '' : 'none'));
    };

    /** Bâtiments des stations, chargés une seule fois en s'approchant d'un village. */
    const loadBuildings = async () => {
      if (buildingsRef.current !== 'idle' || map.getZoom() < BUILDINGS_ZOOM) return;
      buildingsRef.current = 'loading';
      const villages = await Promise.all(
        villageIds.map((id) =>
          fetch(`/data/villages/${encodeURIComponent(id)}.json`)
            .then((r): Promise<Village3d> | null => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      );
      if (cancelled) return;
      map.addSource('buildings', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: villages.flatMap((v) =>
            (v?.buildings ?? []).map((b) => ({
              type: 'Feature' as const,
              properties: { h: b.h, color: facadeColor(b.ring) },
              geometry: { type: 'Polygon' as const, coordinates: [b.ring] },
            })),
          ),
        },
      });
      map.addLayer({
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'buildings',
        minzoom: BUILDINGS_ZOOM,
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-opacity': 0.95,
          'fill-extrusion-vertical-gradient': true,
        },
      });
      buildingsRef.current = 'done';
    };

    /** Lieux du domaine : une pastille par catégorie, les plus utiles au skieur passant devant les autres. */
    /**
     * Forêts en sapins sur la neige, puis routes par-dessus, le tout sous les pistes.
     * Les routes restent visibles avec la neige : elles mènent aux stations et aux parkings.
     */
    const loadForests = async () => {
      const get = (url?: string) =>
        url
          ? fetch(url)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          : Promise.resolve(null);
      const [forests, roads] = await Promise.all([get(domain.forestsUrl), get(domain.roadsUrl)]);
      if (cancelled) return;
      const winter = snowRef.current && baseRef.current === 'satellite';
      if (forests?.features?.length) {
        addForests(map, forests, winter, 'pistes-casing');
        forestTrees = addForestTrees(map, forests, winter, 'pistes-casing');
        quality.refresh();
      }
      // Banc d'essai (?fps, ?bench) : le parcours plonge sur la plus grande forêt du domaine.
      stopPerfProbe = installPerfProbe(map, domain.center, largestForestCenter(forests) ?? domain.center, quality, limiter);
      if (roads?.features?.length) {
        addRoads(map, roads);
        roadLines = (roads as GeoJSON.FeatureCollection).features.flatMap((f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : []));
      }
      syncClearings();
    };

    // Lieux chargés dès l'ouverture, sans attendre la carte : la recherche s'en sert tout de suite.
    // Corrections facultatives (plan officiel, offices de tourisme) : sans elles, la carte reste celle d'OpenStreetMap.
    const correctionsData: Promise<DomainCorrections | null> = domain.correctionsUrl
      ? fetch(domain.correctionsUrl)
          .then((r) => (r.ok ? (r.json() as Promise<DomainCorrections>) : null))
          .catch(() => null)
      : Promise.resolve(null);
    const poisData: Promise<DomainPois | null> = Promise.all([
      fetch(domain.poisUrl)
        .then((r): Promise<DomainPois> | null => (r.ok ? r.json() : null))
        .catch(() => null),
      correctionsData,
    ]).then(([res, corrections]) => (res ? { ...res, pois: applyPoiCorrections(res.pois, corrections) } : null));
    void poisData.then((res) => {
      if (cancelled || !res?.pois.length) return;
      poisRef.current = res.pois;
      setPois(res.pois);
    });

    /** Pastilles des lieux sur la carte, une fois son style prêt. */
    const loadPois = async () => {
      const res = await poisData;
      if (cancelled || !res?.pois.length) return;
      DOMAIN_POI_CATEGORIES.forEach((c) => map.addImage(`poi-${c.id}`, poiIcon(c.emoji, c.color), { pixelRatio: 2 }));
      map.addSource('pois', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: res.pois.map((p) => ({
            type: 'Feature' as const,
            properties: { id: p.id, category: p.category, rank: DOMAIN_POI_CATEGORIES.findIndex((c) => c.id === p.category) },
            geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          })),
        },
      });
      map.addLayer({
        id: 'pois',
        type: 'symbol',
        source: 'pois',
        minzoom: POIS_MIN_ZOOM,
        // Rien d'affiché tant que le filtre des catégories cochées n'est pas posé.
        filter: ['==', ['get', 'category'], ''],
        layout: {
          'icon-image': ['concat', 'poi-', ['get', 'category']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 0.75, 16, 1],
          'icon-padding': 1,
          // Pastille posée au-dessus du point, comme une épingle : le chalet du restaurant reste visible dessous.
          'icon-anchor': 'bottom',
          'icon-offset': [0, -4],
          'symbol-sort-key': ['get', 'rank'],
        },
      });
      map.on('click', 'pois', (e) => {
        if (pickingRef.current) return;
        const poi = poisRef.current.find((p) => p.id === e.features?.[0]?.properties.id);
        if (poi) openPoi(poi);
      });
      // Snowparks et zones ludiques en grand, comme sur les plans des pistes : sous les pistes, étiquette au-dessus.
      const parkZones = parkZoneFeatures(res.zones ?? [], res.pois);
      map.addSource('park-zones', { type: 'geojson', data: parkZones });
      // Sauts, rails et box sur toute la descente des snowparks.
      parkReady = addParkFeatures(
        map,
        parkZones,
        linesRef.current.lifts.map((l) => l.coordinates),
        true,
        'pois',
      );
      const parkColor = ['match', ['get', 'kind'], 'playground', PARK_COLORS.playground, PARK_COLORS.snowpark] as unknown as string;
      map.addLayer(
        { id: 'park-zones-fill', type: 'fill', source: 'park-zones', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': parkColor, 'fill-opacity': 0.42 } },
        'pistes-casing',
      );
      map.addLayer(
        {
          id: 'park-zones-outline',
          type: 'line',
          source: 'park-zones',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'line-color': parkColor, 'line-width': 2, 'line-dasharray': [2, 1.5] },
        },
        'pistes-casing',
      );
      map.addLayer(
        {
          id: 'park-zones-run',
          type: 'line',
          source: 'park-zones',
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': parkColor, 'line-opacity': 0.5, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 11, 6, 14, 30, 17, 220] },
        },
        'pistes-casing',
      );
      map.addLayer(
        {
          id: 'park-zones-label',
          type: 'symbol',
          source: 'park-zones',
          filter: ['==', ['geometry-type'], 'Point'],
          minzoom: 12,
          layout: { 'text-field': ['upcase', ['get', 'label']], 'text-font': LABEL_FONT, 'text-size': 12, 'text-letter-spacing': 0.08 },
          paint: { 'text-color': '#c2410c', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
        },
        'pois',
      );

      // Chalets, toilettes, postes de secours, tables de pique-nique… sous les pastilles des lieux.
      const places = mountainPlaces(res.pois, builtAreas);
      stopBuildings = addPlaceBuildings(map, places, 'pois');
      buildingClearings = placeClearings(places);
      syncClearings();
      // Calques prêts : le filtre des catégories cochées peut s'y appliquer.
      setPoiLayersReady(true);
    };

    const load = async () => {
      const [pisteMap, corrections] = await Promise.all([
        fetch(domain.pistesUrl).then((r): Promise<StationPisteMap> | null => (r.ok ? r.json() : null)),
        correctionsData,
      ]);
      if (cancelled) return;
      if (!pisteMap) {
        setStatus('missing');
        return;
      }
      const data = pisteGeoJson(applyCorrections(pisteMap, corrections));
      linesRef.current = {
        pistes: data.pistes.features.map((f) => ({ name: f.properties.name, detail: f.properties.difficulty, coordinates: f.geometry.coordinates })),
        lifts: data.lifts.features.map((f) => ({ name: f.properties.name, detail: f.properties.liftType, coordinates: f.geometry.coordinates })),
      };
      setLines(linesRef.current);
      syncClearings();
      await styleReady;
      if (cancelled) return;
      markBoot('relief');

      map.addSource('pistes', { type: 'geojson', data: data.pistes });
      map.addSource('lifts', { type: 'geojson', data: data.lifts });
      // Rang de chaque tracé par identifiant OpenStreetMap : état en direct posé par setFeatureState.
      liveIdsRef.current = {
        pistes: new Map(data.pistes.features.map((f) => [String(f.properties.osmId), f.id])),
        lifts: new Map(data.lifts.features.map((f) => [String(f.properties.osmId), f.id])),
      };
      liveAppliedRef.current.clear();
      const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
      // Liseré blanc sous les tracés : les pistes noires et les remontées restent lisibles sur l'image satellite.
      map.addLayer({
        id: 'pistes-casing',
        type: 'line',
        source: 'pistes',
        layout: round,
        paint: { 'line-color': '#ffffff', 'line-opacity': whenShut(0.3, 0.75), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 13, 3.6, 16, 7] },
      });
      map.addLayer({
        id: 'pistes',
        type: 'line',
        source: 'pistes',
        layout: round,
        paint: {
          'line-color': ['match', ['get', 'difficulty'], 'green', PISTE_COLORS.green, 'blue', PISTE_COLORS.blue, 'red', PISTE_COLORS.red, 'black', PISTE_COLORS.black, PISTE_COLORS.unknown],
          // Piste fermée ou hors saison (conditions en direct) : estompée.
          'line-opacity': whenShut(LIVE_CLOSED_OPACITY, 1),
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 13, 2.2, 16, 4.5],
        },
      });
      map.addLayer({
        id: 'lifts-casing',
        type: 'line',
        source: 'lifts',
        filter: NOT_DRAG,
        // Estompé de près : les câbles en 3D prennent le relais.
        paint: { 'line-color': '#ffffff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, whenShut(0.35, 0.8), 14.5, whenShut(0.1, 0.25)], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 3.4] },
      });
      map.addLayer({
        id: 'lifts',
        type: 'line',
        source: 'lifts',
        filter: NOT_DRAG,
        paint: {
          'line-color': '#1a1a20',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12.5, whenShut(LIVE_CLOSED_OPACITY, 1), 14.5, whenShut(0.15, 0.35)],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 14, 1.8],
          'line-dasharray': [3, 2],
        },
      });
      // Tire-fesses : trait plein sombre sur liseré blanc, ponctué de perches.
      map.addImage('drag-tick', dragTickIcon(), { pixelRatio: 2 });
      map.addLayer({
        id: 'lifts-drag',
        type: 'line',
        source: 'lifts',
        filter: IS_DRAG,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#1a1a20',
          'line-opacity': whenShut(LIVE_CLOSED_OPACITY, 1),
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 2],
          'line-gap-width': 0,
        },
      });
      map.addLayer({
        id: 'lifts-drag-ticks',
        type: 'symbol',
        source: 'lifts',
        filter: IS_DRAG,
        minzoom: 12,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 12, 18, 16, 34],
          'icon-image': 'drag-tick',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': whenShut(LIVE_CLOSED_OPACITY, 1) },
      });
      // Piste fermée (conditions en direct) : croix rouge au milieu du tracé. L'état vient de
      // feature-state, que seul le style (pas le filtre) sait lire : la croix est masquée ailleurs.
      map.addImage('closed-cross', closedCrossIcon(), { pixelRatio: 2 });
      map.addLayer({
        id: 'pistes-closed',
        type: 'symbol',
        source: 'pistes',
        filter: LONG_ENOUGH,
        layout: {
          'symbol-placement': 'line-center',
          'icon-image': 'closed-cross',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.9, 13, 1.3, 16, 1.6],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': ['case', ['==', LIVE_STATE, 'closed'], 1, 0] },
      });
      // Tracé survolé, redessiné en surbrillance (toute la piste : mêmes nom et couleur).
      map.addLayer({
        id: 'hover',
        type: 'line',
        source: 'pistes',
        layout: round,
        filter: ['==', ['get', 'name'], '\u0000'],
        paint: { 'line-color': '#ffd43b', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 13, 5.5, 16, 9], 'line-opacity': 0.95 },
      });
      map.addLayer({
        id: 'hover-lift',
        type: 'line',
        source: 'lifts',
        filter: ['==', ['get', 'name'], '\u0000'],
        paint: { 'line-color': '#ffd43b', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5] },
      });

      // Itinéraire : liseré blanc, pistes en orange, remontées en violet, marche en gris.
      map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: round,
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 13], 'line-opacity': 0.95 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: round,
        paint: {
          'line-color': ['match', ['get', 'kind'], 'lift', '#7048e8', 'walk', '#868e96', '#ff6b00'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 7],
        },
      });
      // Noms des pistes et remontées de l'itinéraire, écrits sur le tracé (pendant le guidage).
      map.addLayer({
        id: 'route-labels',
        type: 'symbol',
        source: 'route',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'name'], '']],
        layout: {
          visibility: 'none',
          'text-field': ['get', 'name'],
          'text-font': LABEL_FONT,
          'text-size': 14,
          'symbol-placement': 'line',
          'symbol-spacing': 280,
          'text-max-angle': 30,
        },
        paint: { 'text-color': '#1a1a20', 'text-halo-color': '#ffffff', 'text-halo-width': 2.4 },
      });
      map.addLayer({
        id: 'route-ends',
        type: 'circle',
        source: 'route',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'kind'], 'start', '#1da1f2', '#e03131'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      });
      // Choix du départ : un toucher sur la carte.
      // Clic sur une piste ou une remontée : sa bulle (état en direct, motif, « Y aller »).
      // Un lieu cliqué au même endroit garde la priorité (sa propre bulle).
      map.on('click', (e) => {
        if (pickingRef.current) return;
        if (map.getLayer('pois') && map.queryRenderedFeatures(e.point, { layers: ['pois'] }).length) return;
        const { x, y } = e.point;
        const box = (r: number): [[number, number], [number, number]] => [
          [x - r, y - r],
          [x + r, y + r],
        ];
        // Croix d'une piste fermée sous le doigt : c'est cette piste-là (les croix masquées ne comptent pas).
        const cross = map.getLayer('pistes-closed')
          ? map.queryRenderedFeatures(box(12), { layers: ['pistes-closed'] }).find((h) => h.state?.live === 'closed')
          : undefined;
        // Sinon le tracé le plus proche : petite zone d'abord, élargie si le clic tombe à côté.
        const near = (r: number) => {
          const hit = map.queryRenderedFeatures(box(r), { layers: ['pistes', 'lifts', 'lifts-drag'] });
          return hit.find((h) => h.properties.name) ?? hit[0];
        };
        const f = cross ?? near(3) ?? near(8);
        if (!f) return;
        openTrackRef.current?.({ layer: f.layer.id === 'pistes' || f.layer.id === 'pistes-closed' ? 'pistes' : 'lifts', properties: f.properties }, [e.lngLat.lng, e.lngLat.lat]);
      });
      map.on('click', (e) => {
        if (!pickingRef.current) return;
        setPickedStart({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        setPicking(false);
        // Remis à zéro après les autres gestionnaires du même clic (bulle d'un lieu).
        setTimeout(() => (pickingRef.current = false), 0);
      });

      // Noms le long des tracés, comme sur un plan des pistes : remontées d'abord, pistes de plus près.
      map.addLayer({
        id: 'lift-labels',
        type: 'symbol',
        source: 'lifts',
        minzoom: 13.2,
        filter: ['!=', ['get', 'name'], ''],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': LABEL_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 13.2, 10, 16, 12.5],
          'symbol-placement': 'line',
          'symbol-spacing': 420,
          'text-max-angle': 25,
          'text-letter-spacing': 0.03,
        },
        paint: { 'text-color': '#1a1a20', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      });
      map.addLayer({
        id: 'piste-labels',
        type: 'symbol',
        source: 'pistes',
        minzoom: 14,
        filter: ['!=', ['get', 'name'], ''],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': LABEL_FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 16.5, 12],
          'symbol-placement': 'line',
          'symbol-spacing': 360,
          'text-max-angle': 30,
        },
        paint: {
          'text-color': ['match', ['get', 'difficulty'], 'green', PISTE_COLORS.green, 'blue', PISTE_COLORS.blue, 'red', PISTE_COLORS.red, 'black', PISTE_COLORS.black, PISTE_COLORS.unknown],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
        },
      });

      // Télécabines, télésièges et téléphériques en 3D, immobiles, visibles en s'approchant.
      liftsRef.current = addLifts3d(
        map,
        data.lifts.features.map((f) => ({ name: f.properties.name, liftType: f.properties.liftType, coordinates: f.geometry.coordinates })),
      );

      // Survol : nom de la piste ou de la remontée, et altitude du terrain sous le curseur.
      let hoverKey = '';
      // Au plus une recherche par image (la souris envoie souvent plusieurs mouvements entre deux
      // images), et aucune pendant que la carte bouge : le survol attend que la vue se pose.
      let hoverEvent: MapMouseEvent | null = null;
      let hoverFrame = 0;
      map.on('mousemove', (e) => {
        hoverEvent = e;
        if (!hoverFrame) hoverFrame = requestAnimationFrame(flushHover);
      });
      const flushHover = () => {
        hoverFrame = 0;
        const e = hoverEvent;
        hoverEvent = null;
        if (!e || cancelled || map.isMoving()) return;
        const alt = map.queryTerrainElevation(e.lngLat);
        if (altitudeRef.current) {
          altitudeRef.current.textContent = alt === null ? '—' : `${Math.round(alt / TERRAIN_EXAGGERATION).toLocaleString('fr-FR')} m`;
        }
        const { x, y } = e.point;
        const place = map.getLayer('pois') ? map.queryRenderedFeatures(e.point, { layers: ['pois'] })[0] : undefined;
        const poi = place && poisRef.current.find((p) => p.id === place.properties.id);
        if (poi) {
          if (hoverKey === poi.id) return;
          hoverKey = poi.id;
          map.getCanvas().style.cursor = 'pointer';
          map.setFilter('hover', NO_FEATURE);
          map.setFilter('hover-lift', NO_FEATURE);
          const category = CATEGORY.get(poi.category)!;
          setHover({ color: category.color, title: poi.name, detail: poi.name === poi.kind ? category.label : poi.kind });
          return;
        }
        const hit = map.queryRenderedFeatures(
          [
            [x - 5, y - 5],
            [x + 5, y + 5],
          ],
          { layers: ['pistes', 'lifts', 'lifts-drag'] },
        );
        // Un tracé nommé prime sur une liaison anonyme croisée au même endroit.
        const f = hit.find((h) => h.properties.name) ?? hit[0];
        const isLift = f?.layer.id === 'lifts' || f?.layer.id === 'lifts-drag';
        const name: string = f?.properties.name ?? '';
        const key = f ? `${f.layer.id}|${name}|${f.properties.difficulty ?? f.properties.liftType}` : '';
        if (key === hoverKey) return;
        hoverKey = key;
        map.getCanvas().style.cursor = f ? 'pointer' : '';
        const none = NO_FEATURE;
        if (!f) {
          map.setFilter('hover', none);
          map.setFilter('hover-lift', none);
          setHover(null);
        } else if (isLift) {
          map.setFilter('hover', none);
          map.setFilter('hover-lift', name ? ['==', ['get', 'name'], name] : none);
          const type = LIFT_LABELS[f.properties.liftType] ?? 'Remontée';
          const length = Number(f.properties.length);
          const live = liveText(liveRef.current?.openings.lifts[String(f.properties.osmId)]);
          setHover({ color: '#1a1a20', title: name || type, detail: `${name ? `${type} · ` : ''}${length.toLocaleString('fr-FR')} m`, live });
        } else {
          const difficulty = f.properties.difficulty as PisteDifficulty;
          map.setFilter('hover-lift', none);
          map.setFilter('hover', name ? ['all', ['==', ['get', 'name'], name], ['==', ['get', 'difficulty'], difficulty]] : none);
          const live = liveText(liveRef.current?.openings.pistes[String(f.properties.osmId)]);
          setHover({ color: PISTE_COLORS[difficulty], title: name || 'Liaison', detail: DIFFICULTY_SINGULAR[difficulty], live });
        }
      };

      // Villages et sommets, posés sur le relief ; MapLibre les estompe derrière une crête.
      for (const valley of domain.valleys) {
        for (const village of valley.villages) {
          const el = villageElement(village, () => showVillage(village, valley.bearing));
          markers.push(new Marker({ element: el, anchor: 'bottom' }).setLngLat([village.lng, village.lat]).addTo(map));
        }
      }
      for (const peak of data.peaks) {
        const el = peakElement(peak.name, peak.elevation);
        if ((peak.elevation ?? 0) < MAJOR_PEAK_M) minorPeaks.push(el);
        markers.push(new Marker({ element: el, anchor: 'bottom', opacityWhenCovered: '0' }).setLngLat([peak.lng, peak.lat]).addTo(map));
      }
      syncPeaks();
      map.on('zoom', syncPeaks);
      map.on('zoomend', () => void loadBuildings());

      const bounds = new LngLatBounds();
      for (const f of data.pistes.features) for (const c of f.geometry.coordinates) bounds.extend(c as [number, number]);
      boundsRef.current = bounds;
      if (!sharedView) flyToBounds(bounds, domain.overviewBearing, OVERVIEW_PITCH, false);
      setStatus('ready');
      markBoot('pistes');
      const decor = loadForests().finally(() => markBoot('decor'));
      const places = loadPois()
        .then(() => parkReady)
        .finally(() => markBoot('places'));
      // Vue partagée ouverte de près : les bâtiments n'attendent pas un premier zoom.
      void loadBuildings();
      // Dernière étape : la carte a fini de charger ses tuiles et de dessiner la 3D (ou 8 s au plus).
      void Promise.allSettled([decor, places]).then(() => {
        if (cancelled) return;
        const done = () => markBoot('render');
        const fallback = setTimeout(done, 8000);
        map.once('idle', () => {
          clearTimeout(fallback);
          done();
        });
      });
    };

    load().catch(() => !cancelled && setStatus('error'));

    return () => {
      cancelled = true;
      clearTimeout(bootTimeout);
      if (spinRef.current) cancelAnimationFrame(spinRef.current);
      liftsRef.current?.stop();
      liftsRef.current = null;
      geolocateRef.current = null;
      stopBuildings?.();
      stopPerfProbe?.();
      quality.stop();
      limiter.stop();
      stopTuning();
      forestTrees?.stop();
      markers.forEach((m) => m.remove());
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      buildingsRef.current = 'idle';
    };
    // La carte n'est créée qu'une fois : les fonctions de cadrage lisent des refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.slug, webglOk]);

  // ---- Synchronisation des réglages avec la carte ------------------------------
  useEffect(() => {
    // Lus par les forêts, qui arrivent après coup.
    snowRef.current = snow;
    baseRef.current = base;
    const map = mapRef.current;
    // Calque absent : carte recréée (remontage du composant) dont le style n'est pas encore chargé.
    if (!map || status !== 'ready' || !map.getLayer('base-satellite')) return;
    map.setLayoutProperty('base-satellite', 'visibility', base === 'satellite' ? 'visible' : 'none');
    map.setLayoutProperty('base-topo', 'visibility', base === 'topo' ? 'visible' : 'none');
    applyWinter(map, base === 'satellite' && snow);
  }, [base, snow, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready' || !map.getLayer('pistes')) return;
    // Les tronçons non classés suivent l'affichage général : visibles tant qu'une couleur l'est.
    const shown = enabled.size > 0 ? [...enabled, 'unknown'] : [];
    const filter: FilterSpecification = ['in', ['get', 'difficulty'], ['literal', shown]];
    map.setFilter('pistes', filter);
    map.setFilter('pistes-casing', filter);
    if (map.getLayer('pistes-closed')) map.setFilter('pistes-closed', ['all', filter, LONG_ENOUGH]);
    if (map.getLayer('piste-labels')) map.setFilter('piste-labels', ['all', filter, ['!=', ['get', 'name'], '']]);
  }, [enabled, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    for (const id of ['lifts', 'lifts-casing', 'lifts-drag', 'lifts-drag-ticks', 'lift-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', showLifts ? 'visible' : 'none');
    }
    for (const id of LIFT_3D_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', showLifts ? 'visible' : 'none');
    }
  }, [showLifts, status]);

  // Conditions en direct : état de chaque tracé (feature-state), relu par le survol.
  useEffect(() => {
    liveRef.current = live.data;
    const map = mapRef.current;
    const ids = liveIdsRef.current;
    if (!map || status !== 'ready' || !ids || !live.data || !map.getSource('pistes')) return;
    // Source muette : on garde le dernier état posé plutôt que de tout rallumer.
    if (!live.data.openings.source.ok) return;
    const applied = liveAppliedRef.current;
    // Tracés sans état (liaisons sans nom, noms absents de la source) : neutres, sauf hors saison
    // où rien n'est ouvert.
    const fallback = live.data.openings.outOfSeason ? 'out' : '';
    for (const source of ['pistes', 'lifts'] as const) {
      const states = live.data.openings[source];
      for (const [osmId, id] of ids[source]) {
        if (id === undefined) continue;
        // Hors saison, une station peut dire « fermée » plutôt que « hors saison » (Risoul) : tout est
        // alors estompé pareil, sans croix rouge sur chaque piste.
        const raw = states[osmId]?.status ?? fallback;
        const next = live.data.openings.outOfSeason && raw === 'closed' ? 'out' : raw;
        const key = `${source}|${id}`;
        if ((applied.get(key) ?? '') === next) continue;
        applied.set(key, next);
        map.setFeatureState({ source, id }, { live: next || null });
      }
    }
  }, [live.data, status]);

  // Les pastilles suivent les catégories cochées dans le panneau ; un type de lieu choisi dans la
  // recherche (« Restaurants »…) ne laisse que ces lieux-là sur la carte, cochés ou non.
  const searchedPoi = SEARCH_KIND_POIS[searchKind];
  useEffect(() => {
    const map = mapRef.current;
    if (!map || pois.length === 0 || !map.getLayer('pois')) return;
    const shown = searchedPoi ? new Set<DomainPoiCategoryId>([searchedPoi]) : enabledPois;
    map.setFilter('pois', ['in', ['get', 'category'], ['literal', [...shown]]]);
    for (const id of ['park-zones-fill', 'park-zones-outline', 'park-zones-run', 'park-zones-label', PARK_FEATURES_LAYER]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', shown.has('snowpark') ? 'visible' : 'none');
    }
    // Leurs bâtiments suivent les mêmes cases.
    if (map.getLayer(BUILDINGS_LAYER)) map.setFilter(BUILDINGS_LAYER, ['in', ['get', 'cat'], ['literal', [...shown]]]);
    const open = popupRef.current;
    // La bulle d'un lieu dont on vient de masquer la catégorie n'a plus de repère : on la ferme.
    if (open?.isOpen()) {
      const { lng, lat } = open.getLngLat();
      const poi = pois.find((p) => p.lng === lng && p.lat === lat);
      if (poi && !shown.has(poi.category)) open.remove();
    }
  }, [enabledPois, searchedPoi, pois, poiLayersReady]);

  const poiCounts = useMemo(() => {
    const counts = new Map<DomainPoiCategoryId, number>();
    pois.forEach((p) => counts.set(p.category, (counts.get(p.category) ?? 0) + 1));
    return counts;
  }, [pois]);

  /** Tout ce que l'on peut chercher : lieux, remontées, pistes (une entrée par nom et couleur) et stations. */
  const searchIndex = useMemo<SearchEntry[]>(() => {
    const entries: SearchEntry[] = pois.map((p) => ({
      id: p.id,
      kind: p.category === 'restaurant' ? 'restaurant' : p.category === 'hut' ? 'hut' : p.category === 'toilets' && p.kind === 'Toilettes' ? 'toilets' : 'other',
      name: p.name,
      sub: p.kind,
      emoji: CATEGORY.get(p.category)!.emoji,
      lng: p.lng,
      lat: p.lat,
      poi: p,
    }));
    lines.lifts.forEach((l, i) => {
      if (!l.name) return;
      // Gare du bas : les remontées sont tracées du bas vers le haut.
      const [lng, lat] = l.coordinates[0];
      entries.push({ id: `lift/${i}`, kind: 'lift', name: l.name, sub: LIFT_LABELS[l.detail] ?? 'Remontée', emoji: '🚡', lng, lat, liftName: l.name });
    });
    const pistes = new Map<string, NamedLine[]>();
    for (const p of lines.pistes) {
      if (!p.name) continue;
      const key = `${p.name}|${p.detail}`;
      pistes.set(key, [...(pistes.get(key) ?? []), p]);
    }
    for (const [key, parts] of pistes) {
      const longest = parts.reduce((a, b) => (b.coordinates.length > a.coordinates.length ? b : a));
      const [lng, lat] = longest.coordinates[Math.floor(longest.coordinates.length / 2)];
      const difficulty = parts[0].detail as PisteDifficulty;
      entries.push({
        id: `piste/${key}`,
        kind: 'piste',
        name: parts[0].name,
        sub: DIFFICULTY_SINGULAR[difficulty] ?? 'Piste',
        emoji: '',
        color: PISTE_COLORS[difficulty] ?? PISTE_COLORS.unknown,
        lng,
        lat,
        lines: parts.map((x) => x.coordinates),
        pisteKey: { name: parts[0].name, difficulty },
      });
    }
    for (const valley of domain.valleys) {
      for (const v of valley.villages) {
        entries.push({ id: `village/${v.name}`, kind: 'village', name: v.name, sub: `${valley.name} · ${v.altitude.toLocaleString('fr-FR')} m`, emoji: '🏔️', lng: v.lng, lat: v.lat, village: { village: v, bearing: valley.bearing } });
      }
    }
    return entries;
  }, [pois, lines, domain.valleys]);

  /** Résultats : le type choisi, filtré par le texte, du plus proche au plus loin si l'on est localisé. */
  /** Types de recherche qui ont au moins un résultat (pas de puce « Refuges » sans refuge). */
  const searchKinds = useMemo(() => {
    const present = new Set(searchIndex.map((e) => e.kind));
    return SEARCH_KINDS.filter((k) => k.id === 'all' || present.has(k.id));
  }, [searchIndex]);

  const found = useMemo(() => {
    const q = normalize(query.trim());
    if (searchKind === 'all' && q.length < 2) return null;
    const list = searchIndex.filter((e) => (searchKind === 'all' || e.kind === searchKind) && (!q || normalize(`${e.name} ${e.sub}`).includes(q)));
    const from = here && here.offDomain === null ? here : null;
    const dist = (e: SearchEntry) => (from ? Math.hypot((e.lng - from.lng) * 111_320 * Math.cos((from.lat * Math.PI) / 180), (e.lat - from.lat) * 110_574) : 0);
    return list
      .map((e) => ({ entry: e, distance: from ? dist(e) : null }))
      .sort((a, b) => (from ? a.distance! - b.distance! : a.entry.name.localeCompare(b.entry.name, 'fr')));
  }, [searchIndex, query, searchKind, here]);

  const togglePoiCategory = (id: DomainPoiCategoryId) =>
    setEnabledPois((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Rotation automatique autour du centre de la vue, arrêtée dès qu'on reprend la main.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !spinning) return;
    const step = () => {
      map.setBearing(map.getBearing() + 0.06);
      spinRef.current = requestAnimationFrame(step);
    };
    spinRef.current = requestAnimationFrame(step);
    const stop = () => setSpinning(false);
    map.once('mousedown', stop);
    map.once('touchstart', stop);
    map.once('wheel', stop);
    return () => {
      if (spinRef.current) cancelAnimationFrame(spinRef.current);
      map.off('mousedown', stop);
      map.off('touchstart', stop);
      map.off('wheel', stop);
    };
  }, [spinning]);

  const toggleDifficulty = (d: PisteDifficulty) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });

  // Message bref, effacé tout seul.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const locate = async () => {
    setSpinning(false);
    if (!('geolocation' in navigator)) {
      setNotice('Ce navigateur ne permet pas la localisation.');
      return;
    }
    // Localisation déjà refusée : le navigateur ne redemandera pas, on explique comment faire.
    const permission = await navigator.permissions?.query({ name: 'geolocation' }).then((r) => r.state, () => null);
    if (permission === 'denied') {
      setGeoStatus('denied');
      setNotice('Localisation bloquée : autorisez-la pour ce site dans les réglages du navigateur, puis réessayez.');
      return;
    }
    if (!isWide()) setPanelOpen(false);
    geolocateRef.current?.trigger();
  };

  const recenter = () => {
    if (!here) return;
    mapRef.current?.flyTo({ center: [here.lng, here.lat], zoom: Math.max(mapRef.current.getZoom(), 15), duration: 1500, offset: panelOffset() });
  };

  /** Partage de la vue courante : feuille de partage du téléphone, sinon lien copié. */
  const share = async () => {
    // Intégrée : on partage la carte plein écran d'AltiStay, pas l'adresse de l'iframe.
    // Dans l'appli mobile (paquet hors ligne), l'adresse publique de la carte, pas celle du téléphone.
    const url = embedded ? `${siteOrigin()}/carte/${domain.slug}${window.location.hash}` : window.location.href;
    try {
      if (navigator.share && !isWide()) {
        await navigator.share({ title: `${domain.name} en 3D`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setNotice('Lien de cette vue copié : collez-le pour la partager.');
    } catch {
      // Partage annulé par l'utilisateur : rien à signaler.
    }
  };

  // ---- Itinéraire à ski -----------------------------------------------------------------
  /** Itinéraire à afficher : en simulation, le tracé figé, raccourci de la distance parcourue. */
  const shownRoute = useMemo(
    () => (simulating && simRoute ? trimRoute(simRoute, simDistance) : routeStatus === 'ready' ? route : null),
    [simulating, simRoute, simDistance, route, routeStatus],
  );
  const gpsStart = geoStatus === 'on' && here && here.offDomain === null ? { lng: here.lng, lat: here.lat } : null;
  // Hors guidage, le point choisi sur la carte prime. Pendant le guidage, la position GPS prime ;
  // tant qu'elle n'est pas reçue, l'itinéraire reste affiché depuis le point choisi.
  const routeStart = navigating ? (gpsStart ?? pickedStart) : (pickedStart ?? gpsStart);
  const fromGps = !!gpsStart && routeStart === gpsStart;
  /** Repère du départ choisi, tant que c'est lui qui sert de départ. */
  const startMarker = !fromGps ? pickedStart : null;
  // Sans guidage, l'itinéraire est calculé une fois depuis la position du moment ; pendant le
  // guidage, il est recalculé tous les trente mètres environ (position arrondie).
  // En simulation, l'itinéraire est figé : la fausse position le parcourt sans le recalculer.
  const startKey = simulating
    ? 'simulation'
    : !routeStart
    ? ''
    : !fromGps
      ? `p${routeStart.lng},${routeStart.lat}`
      : navigating
        ? `g${Math.round(routeStart.lng * 2500)},${Math.round(routeStart.lat * 3500)}`
        : 'gps';

  /**
   * Pistes et remontées fermées d'après les conditions en direct (index des tracés de la carte,
   * les mêmes que ceux du réseau d'itinéraire). Hors saison, rien n'est exclu : l'itinéraire
   * reste un aperçu du domaine plutôt que « aucun chemin ».
   */
  const closedKey = useMemo(() => {
    const o = live.data?.openings;
    if (!o?.source.ok || o.outOfSeason) return '';
    const shut = (states: Record<string, LiveItemState>) =>
      Object.entries(states)
        .filter(([, st]) => st.status === 'closed')
        .map(([id]) => id)
        .sort()
        .join(',');
    return `${shut(o.pistes)}|${shut(o.lifts)}`;
  }, [live.data]);
  const closedLines = (): ClosedLines | undefined => {
    const ids = liveIdsRef.current;
    if (!closedKey || !ids) return undefined;
    const [pistes, lifts] = closedKey.split('|');
    const toIndex = (list: string, map: Map<string, string | number | undefined>) =>
      new Set(list ? list.split(',').flatMap((osmId) => (typeof map.get(osmId) === 'number' ? [map.get(osmId) as number] : [])) : []);
    return { pistes: toIndex(pistes, ids.pistes), lifts: toIndex(lifts, ids.lifts) };
  };
  /** Pistes et remontées fermées, comptées par nom (une piste OSM est souvent découpée en tronçons). */
  const countClosed = (closed: ClosedLines | undefined) => {
    if (!closed) return 0;
    const { pistes, lifts } = linesRef.current;
    const names = new Set<string>();
    closed.pistes.forEach((i) => pistes[i] && names.add(`p|${pistes[i].name || i}|${pistes[i].detail}`));
    closed.lifts.forEach((i) => lifts[i] && names.add(`l|${lifts[i].name || i}`));
    return names.size;
  };
  /** Nombre de tracés fermés évités par l'itinéraire affiché. */
  const [closedCount, setClosedCount] = useState(0);

  /** Réseau des pistes, construit une fois au premier itinéraire (relief à charger). */
  const ensureGraph = () => {
    if (!graphRef.current) {
      const { pistes, lifts } = linesRef.current;
      const all = [...pistes, ...lifts].flatMap((l) => l.coordinates);
      const lngs = all.map((c) => c[0]);
      const lats = all.map((c) => c[1]);
      graphRef.current = loadTerrain([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]).then((t) =>
        buildSkiGraph(pistes, lifts, t.elevation),
      );
      // Échec (réseau) : on retentera au prochain calcul.
      graphRef.current.catch(() => (graphRef.current = null));
    }
    return graphRef.current;
  };

  const goalTargets = (goal: RouteGoal): RouteTarget[] | 'lift' => {
    if (goal.kind === 'lift') return 'lift';
    if (goal.kind === 'poi') return [{ id: goal.poi.id, name: goal.poi.name, lng: goal.poi.lng, lat: goal.poi.lat }];
    if (goal.kind === 'place') return [goal.place];
    if (goal.kind === 'village') {
      const v = domain.valleys.flatMap((x) => x.villages).find((x) => x.name === goal.name);
      return v ? [{ id: `village/${v.name}`, name: v.name, lng: v.lng, lat: v.lat }] : [];
    }
    return poisRef.current
      .filter((p) => (goal.category === 'restaurant' ? p.category === 'restaurant' || p.category === 'hut' : p.category === 'toilets' && p.kind === 'Toilettes'))
      .map((p) => ({ id: p.id, name: p.name, lng: p.lng, lat: p.lat }));
  };

  // Calcul (ou recalcul quand le skieur avance) de l'itinéraire.
  useEffect(() => {
    if (!routeOpen || !routeGoal || !routeStart) return;
    let stale = false;
    const run = async () => {
      const ready = graphRef.current;
      if (!ready) setRouteStatus('preparing');
      const g = await ensureGraph();
      if (stale) return;
      const closed = closedLines();
      const result = planRoute(g, routeStart, goalTargets(routeGoal), routeLevel, closed);
      setClosedCount(countClosed(closed));
      setRoute(result);
      setRouteStatus(result ? 'ready' : 'none');
      // Arrivé à moins de 60 m de la destination (à vol d'oiseau) : fin du guidage.
      const toTarget = result
        ? Math.hypot((result.target.lng - routeStart.lng) * 111_320 * Math.cos((routeStart.lat * Math.PI) / 180), (result.target.lat - routeStart.lat) * 110_574)
        : Infinity;
      if (navigatingRef.current && fromGps && result && toTarget < 60) {
        navigatingRef.current = false;
        setNavigating(false);
        // Fin de la simulation éventuelle (même effet que endSimulation, déclarée plus bas).
        if (simulatingRef.current) {
          simulatingRef.current = false;
          setSimulating(false);
          setHere(null);
          setGeoStatus('off');
        }
        setNotice(`Vous êtes arrivé : ${result.target.name}.`);
      }
    };
    run().catch(() => {
      if (stale) return;
      setRoute(null);
      setRouteStatus('none');
    });
    return () => {
      stale = true;
    };
    // Recalcul sur le départ arrondi (startKey), pas sur chaque position GPS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeOpen, routeGoal, routeLevel, startKey, closedKey]);

  // Tracé de l'itinéraire sur la carte, et cadrage quand la destination change.
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource('route') as GeoJSONSource | undefined;
    if (!map || !source) return;
    const shown = routeOpen ? shownRoute : null;
    const features: GeoJSON.Feature[] = [];
    if (shown) {
      for (const s of shown.steps) {
        const color = s.kind === 'lift' ? ROUTE_LIFT_COLOR : s.kind === 'walk' ? ROUTE_WALK_COLOR : (PISTE_COLORS[s.detail as PisteDifficulty] ?? PISTE_COLORS.unknown);
        features.push({
          type: 'Feature',
          properties: { kind: s.kind, color, name: s.kind === 'walk' ? '' : s.name },
          geometry: { type: 'LineString', coordinates: s.coordinates },
        });
      }
      if (startMarker) features.push({ type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: [startMarker.lng, startMarker.lat] } });
      features.push({ type: 'Feature', properties: { kind: 'end' }, geometry: { type: 'Point', coordinates: [shown.target.lng, shown.target.lat] } });
    } else if (routeOpen && startMarker) {
      features.push({ type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: [startMarker.lng, startMarker.lat] } });
    }
    source.setData({ type: 'FeatureCollection', features });

    const key = shown ? `${shown.target.id}|${routeLevel}|${startMarker ? `${startMarker.lng},${startMarker.lat}` : 'gps'}` : '';
    if (shown && key !== framedRef.current) {
      const bounds = new LngLatBounds();
      shown.steps.forEach((s) => s.coordinates.forEach((c) => bounds.extend(c as [number, number])));
      bounds.extend([shown.target.lng, shown.target.lat]);
      // Trajet très court (toilettes voisines) : pas plus près que la vue d'un village.
      flyToBounds(bounds, map.getBearing(), Math.min(map.getPitch(), 60), true, 16);
    }
    framedRef.current = key;
    // flyToBounds lit des refs : inutile de relancer l'effet pour elle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownRoute, routeOpen, startMarker, routeLevel]);

  const openRoute = (goal?: RouteGoal) => {
    setSpinning(false);
    setRouteOpen(true);
    if (goal) setRouteGoal(goal);
    if (!isWide()) setPanelOpen(false);
    // Sans GPS ni départ choisi : on propose de toucher la carte.
    if (!pickedStart && !gpsStart) {
      pickingRef.current = true;
      setPicking(true);
    }
  };

  /** Fin de la simulation : la fausse position disparaît. */
  const endSimulation = () => {
    if (!simulatingRef.current) return;
    simulatingRef.current = false;
    setSimulating(false);
    setHere(null);
    setGeoStatus('off');
  };

  const stopNavigation = () => {
    navigatingRef.current = false;
    setNavigating(false);
    endSimulation();
  };

  /** Simulation : guidage lancé, la position avance toute seule le long de l'itinéraire. */
  const startSimulation = () => {
    if (!route) return;
    simPathRef.current = simPath(route);
    setSimRoute(route);
    simRouteName.current = route.target.name;
    setSimDistance(0);
    setPicking(false);
    pickingRef.current = false;
    navigatingRef.current = true;
    setNavigating(true);
    simulatingRef.current = true;
    setSimulating(true);
    setPanelOpen(false);
  };

  // Avancée de la position simulée, et son repère sur la carte.
  useEffect(() => {
    const map = mapRef.current;
    const path = simPathRef.current;
    if (!simulating || !map || path.length < 2) return;
    let travelled = 0;
    const dot = document.createElement('div');
    dot.className = 'h-5 w-5 rounded-full border-[3px] border-white bg-[#1da1f2] shadow-[0_0_0_6px_rgba(29,161,242,0.25)]';
    const marker = new Marker({ element: dot }).setLngLat([path[0].lng, path[0].lat]).addTo(map);
    let i = 0;
    let { lng, lat } = path[0];
    const tick = () => {
      let budget = (path[Math.min(i + 1, path.length - 1)].speed * SIM_SPEEDUP * SIM_TICK_MS) / 1000;
      while (budget > 0 && i < path.length - 1) {
        const next = path[i + 1];
        const d = Math.hypot((next.lng - lng) * 111_320 * Math.cos((lat * Math.PI) / 180), (next.lat - lat) * 110_574);
        if (d <= budget) {
          budget -= d;
          travelled += d;
          ({ lng, lat } = next);
          i++;
        } else {
          lng += ((next.lng - lng) * budget) / d;
          lat += ((next.lat - lat) * budget) / d;
          travelled += budget;
          budget = 0;
        }
      }
      marker.setLngLat([lng, lat]);
      const coords = { latitude: lat, longitude: lng, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null } as GeolocationCoordinates;
      if (describeRef.current) setHere(describeRef.current(coords));
      setGeoStatus('on');
      setSimDistance(travelled);
      if (i >= path.length - 1) {
        clearInterval(timer);
        setNotice(`Vous êtes arrivé : ${simRouteName.current}. Fin de la simulation.`);
        navigatingRef.current = false;
        setNavigating(false);
        simulatingRef.current = false;
        setSimulating(false);
        setHere(null);
        setGeoStatus('off');
      }
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, SIM_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      marker.remove();
    };
  }, [simulating]);

  // Guidage : seul l'itinéraire reste net, pistes à leur couleur et remontées en jaune ;
  // le reste du domaine est grisé et estompé.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    const saved = fadedRef.current;
    for (const [id, prop, faded] of FADED_WHILE_GUIDING) {
      if (!map.getLayer(id)) continue;
      const key = `${id}|${prop}`;
      if (navigating) {
        if (!saved.has(key)) saved.set(key, getPaint(map, id, prop) ?? null);
        setPaint(map, id, prop, faded);
      } else if (saved.has(key)) {
        setPaint(map, id, prop, saved.get(key) ?? undefined);
        saved.delete(key);
      }
    }
    if (map.getLayer('route-line')) {
      setPaint(map, 'route-line', 'line-color', navigating ? ['get', 'color'] : ROUTE_PREVIEW_COLOR);
      map.setPaintProperty('route-line', 'line-width', ['interpolate', ['linear'], ['zoom'], 10, navigating ? 4 : 3, 15, navigating ? 10 : 7]);
      map.setLayoutProperty('route-labels', 'visibility', navigating ? 'visible' : 'none');
      // Liseré blanc plus large pendant le guidage : l'itinéraire se détache du reste.
      map.setPaintProperty('route-casing', 'line-width', ['interpolate', ['linear'], ['zoom'], 10, navigating ? 8 : 6, 15, navigating ? 17 : 13]);
    }
  }, [navigating, status]);


  /** Résultat de recherche : la vue s'y rend, et la piste ou la remontée est surlignée. */
  const showEntry = (e: SearchEntry) => {
    const map = mapRef.current;
    if (!map) return;
    if (e.poi) return showPoi(e.poi);
    if (e.village) return showVillage(e.village.village, e.village.bearing);
    setSpinning(false);
    if (!isWide()) setPanelOpen(false);
    if (e.liftName) map.setFilter('hover-lift', ['==', ['get', 'name'], e.liftName]);
    if (e.pisteKey) map.setFilter('hover', ['all', ['==', ['get', 'name'], e.pisteKey.name], ['==', ['get', 'difficulty'], e.pisteKey.difficulty]]);
    map.flyTo({ center: [e.lng, e.lat], zoom: 15.2, pitch: 60, duration: 2000, offset: panelOffset() });
  };

  /** Itinéraire vers un résultat : gare du bas d'une remontée, haut d'une piste, centre d'une station. */
  const routeToEntry = (e: SearchEntry) => {
    if (e.poi) return openRoute({ kind: 'poi', poi: e.poi });
    let { lng, lat } = e;
    if (e.lines) {
      // Haut de la piste : le bout le plus élevé de ses tronçons (relief affiché), à défaut son premier point.
      const map = mapRef.current;
      let best = -Infinity;
      for (const coords of e.lines) {
        for (const c of [coords[0], coords[coords.length - 1]]) {
          const z = map?.queryTerrainElevation([c[0], c[1]]) ?? null;
          if (z !== null && z > best) {
            best = z;
            [lng, lat] = c;
          }
        }
      }
      if (best === -Infinity) [lng, lat] = e.lines[0][0];
    }
    openRoute({ kind: 'place', place: { id: e.id, name: e.name, lng, lat } });
  };

  const closeRoute = () => {
    stopNavigation();
    setRouteOpen(false);
    setPicking(false);
    pickingRef.current = false;
  };

  /** Lancement du guidage : départ depuis la position GPS, suivie en continu. */
  const startNavigation = () => {
    // Le point choisi reste le départ affiché tant que la position GPS n'est pas reçue.
    setPicking(false);
    pickingRef.current = false;
    navigatingRef.current = true;
    setNavigating(true);
    setPanelOpen(false);
    if (geoStatus !== 'on') void locate();
  };

  /**
   * « Y aller » depuis la bulle d'un lieu : itinéraire vers ce lieu, et guidage lancé
   * tout de suite si un départ est connu (GPS ou point choisi) ; sinon, la fiche
   * d'itinéraire propose de choisir le départ.
   */
  const goTo = (goal: RouteGoal) => {
    popupRef.current?.remove();
    openRoute(goal);
    if (gpsStart || pickedStart || geoStatus === 'searching') startNavigation();
  };

  /**
   * Bulle d'une piste ou d'une remontée : état en direct (ouverte, fermée et pourquoi), longueur
   * de la piste entière (tous ses tronçons de même nom et couleur), et « Y aller » : vers le haut
   * de la piste, ou la gare de départ de la remontée.
   */
  const openTrack = (f: { layer: 'pistes' | 'lifts'; properties: Record<string, unknown> }, at: [number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    const props = f.properties;
    const osmId = String(props.osmId);
    const name = String(props.name ?? '');
    const openings = liveRef.current?.openings;
    const liveOk = !!openings?.source.ok;
    const demo = !!liveRef.current?.demo;
    // Hors saison, « fermée » se lit « hors saison » (comme sur la carte, sans croix).
    const seasonal = (st: LiveItemState | undefined): LiveItemState | undefined =>
      openings?.outOfSeason && st?.status === 'closed' ? { ...st, status: 'out', label: 'Hors saison', message: undefined } : st;
    popupRef.current?.remove();
    if (f.layer === 'pistes') {
      const difficulty = props.difficulty as PisteDifficulty;
      // Tous les tronçons de la piste (une piste sans nom : ce seul tronçon).
      const own = linesRef.current.pistes.filter((l) => (name ? l.name === name && l.detail === difficulty : false));
      const segments = own.length ? own.map((l) => l.coordinates) : [];
      const length = segments.length ? segments.reduce((sum, c) => sum + lineLength(c), 0) : Number(props.length ?? 0);
      const go = () => {
        let best = -Infinity;
        let top: number[] = segments[0]?.[0] ?? at;
        for (const coords of segments) {
          for (const c of [coords[0], coords[coords.length - 1]]) {
            const z = map.queryTerrainElevation([c[0], c[1]]);
            if (z !== null && z > best) {
              best = z;
              top = c;
            }
          }
        }
        goToRef.current?.({ kind: 'place', place: { id: `piste/${osmId}`, name: name || 'Liaison', lng: top[0], lat: top[1] } });
      };
      popupRef.current = openReactPopup(map, at, (close) => (
        <TrackCard
          kind="piste"
          name={name || 'Liaison'}
          typeLabel={DIFFICULTY_SINGULAR[difficulty] ?? 'Piste'}
          color={PISTE_COLORS[difficulty] ?? PISTE_COLORS.unknown}
          length={length}
          state={seasonal(openings?.pistes[osmId])}
          outOfSeason={!!openings?.outOfSeason}
          liveAvailable={liveOk}
          demo={demo}
          goLabel="Aller en haut de la piste"
          onGo={go}
          onClose={close}
        />
      ));
      return;
    }
    const type = LIFT_LABELS[String(props.liftType)] ?? 'Remontée';
    const lift = linesRef.current.lifts.find((l) => l.name === name && l.detail === props.liftType);
    const bottom = lift?.coordinates[0] ?? at;
    popupRef.current = openReactPopup(map, at, (close) => (
      <TrackCard
        kind="lift"
        name={name || type}
        typeLabel={type}
        color="#1a1a20"
        length={Number(props.length ?? 0)}
        state={seasonal(openings?.lifts[osmId])}
        outOfSeason={!!openings?.outOfSeason}
        liveAvailable={liveOk}
        demo={demo}
        goLabel="Aller à la gare de départ"
        onGo={() => goToRef.current?.({ kind: 'place', place: { id: `lift/${osmId}`, name: name || type, lng: bottom[0], lat: bottom[1] } })}
        onClose={close}
      />
    ));
  };

  // Les bulles (créées hors de React) appellent les versions à jour de ces fonctions.
  useEffect(() => {
    goToRef.current = goTo;
    openTrackRef.current = openTrack;
  });

  // Pendant le guidage, la carte suit le skieur, vue inclinée vers l'avant.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !navigating || !here) return;
    // Vue « Waze » : orientée vers la suite de l'itinéraire, un peu devant le skieur.
    const ahead = shownRoute ? pointAhead(shownRoute, 200) : null;
    const bearing = ahead ? headingTo(here, ahead) : map.getBearing();
    // Caméra proche, derrière le skieur. Pas trop rasante : en descente, elle est placée en amont
    // et la pente cacherait le skieur et le tracé devant lui.
    map.easeTo({ center: [here.lng, here.lat], zoom: 17.4, pitch: 58, bearing, duration: 900, offset: [0, 90] });
  }, [navigating, here, shownRoute]);

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm transition ${
      active ? 'border-primary bg-primary text-primary-foreground' : 'border-winter-200 bg-card/95 text-foreground/75 hover:border-primary'
    }`;

  const panelHeading = 'mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/55';
  const panelLink =
    'inline-flex h-9 items-center gap-1.5 rounded-full px-2 text-[13px] font-semibold text-foreground/60 transition-colors hover:bg-winter-50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
  const textButton =
    'inline-flex h-8 items-center rounded-full px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-winter-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

  const ready = status === 'ready';
  const booting = ready && boot.length < BOOT_STEPS.length;

  return (
    <div className="fixed inset-0 overflow-hidden bg-winter-900">
      {/* Position en style direct : la feuille de style de MapLibre impose `position: relative` à la carte. */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Panneau du domaine */}
      {panelOpen && (
        <aside className="absolute inset-x-3 bottom-3 z-20 flex max-h-[68vh] flex-col overflow-hidden rounded-[28px] border border-white/70 bg-background/95 shadow-2xl backdrop-blur-md sm:right-auto sm:top-3 sm:max-h-none sm:w-[360px]">
          {/* En-tête : nom du domaine, chiffres, recherche et onglets restent visibles. */}
          <div className="border-b border-winter-100 bg-card/80 px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              {embedded ? (
                <a href={`${siteOrigin()}/carte/${domain.slug}`} target="_blank" rel="noopener" className={panelLink}>
                  Carte AltiStay <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : SEARCH_SITE_URL ? (
                <a href={SEARCH_SITE_URL} className={panelLink}>
                  <ArrowLeft className="h-4 w-4" aria-hidden /> AltiStay
                </a>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                aria-label="Masquer le panneau"
                className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-winter-50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-1">
              <h1 className={`font-display leading-tight text-foreground ${domain.name.length > 14 ? 'text-2xl sm:text-[26px]' : 'text-2xl sm:text-3xl'}`}>
                {domain.name} <span className="italic text-accent">en 3D</span>
              </h1>
              <p className="mt-0.5 hidden text-[13px] text-foreground/55 sm:block">{domain.subtitle}</p>
              {live.data?.demo && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                  <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Simulation pleine saison
                </p>
              )}
            </div>

            {stats && (
              <dl className="mt-3 hidden grid-cols-3 divide-x divide-winter-100 rounded-2xl bg-winter-50/70 py-2.5 text-center sm:grid">
                {[
                  [stats.totalKm.toLocaleString('fr-FR'), 'km de pistes'],
                  [stats.slopes.toLocaleString('fr-FR'), 'pistes'],
                  [stats.lifts.toLocaleString('fr-FR'), 'remontées'],
                ].map(([value, label]) => (
                  <div key={label} className="flex flex-col-reverse">
                    <dt className="mt-1 text-[11px] text-foreground/55">{label}</dt>
                    <dd className="font-display text-[22px] leading-none text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/45" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPanelTab('explore');
                }}
                placeholder={searchKind === 'all' ? 'Restaurant, remontée, piste, station…' : `Nom (${SEARCH_KINDS.find((k) => k.id === searchKind)!.label.toLowerCase()})…`}
                aria-label="Rechercher sur la carte"
                className="h-11 w-full rounded-2xl border border-winter-200 bg-card pl-10 pr-10 text-[15px] text-foreground placeholder:text-foreground/40 transition focus:border-primary/50 focus:outline-none focus:ring-4 focus:ring-primary/10 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Effacer la recherche"
                  className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-foreground/45 hover:bg-winter-50 hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {domain.live && (
              <div role="tablist" aria-label="Contenu du panneau" className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-winter-50 p-1">
                {PANEL_TABS.map(([id, label]) => {
                  const active = panelTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setPanelTab(id)}
                      className={`inline-flex h-9 items-center justify-center gap-2 rounded-full text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                        active ? 'bg-card text-foreground shadow-sm' : 'text-foreground/55 hover:text-foreground'
                      }`}
                    >
                      {id === 'conditions' && <span className={`h-2 w-2 rounded-full ${live.data && !live.failed && !live.data.demo ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />}
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Une zone de défilement par onglet : chacun s'ouvre en haut. */}
          <div key={panelTab} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            {domain.live && panelTab === 'conditions' ? (
              <LivePanel state={live} demo={demo} onToggleDemo={toggleDemo} />
            ) : (
              <div className="space-y-6">
                <section aria-label="Recherche">
                  <div className="flex flex-wrap gap-1.5">
                    {searchKinds.map((k) => {
                      const Icon = SEARCH_ICONS[k.id];
                      const active = searchKind === k.id;
                      return (
                        <button
                          key={k.id}
                          type="button"
                          onClick={() => setSearchKind(active && k.id !== 'all' ? 'all' : k.id)}
                          aria-pressed={active}
                          className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                            active ? 'border-primary bg-primary text-primary-foreground' : 'border-winter-200 bg-card text-foreground/75 hover:border-primary/60 hover:text-foreground'
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                          {k.label}
                        </button>
                      );
                    })}
                  </div>

                  {searchedPoi && (
                    <p className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-winter-50 px-3 py-2 text-xs text-foreground/70">
                      <span>
                        Carte : seuls les <span className="font-semibold text-foreground">{CATEGORY.get(searchedPoi)!.label.toLowerCase()}</span> sont affichés.
                      </span>
                      <button type="button" onClick={() => setSearchKind('all')} className="shrink-0 font-semibold text-primary hover:underline">
                        Tout afficher
                      </button>
                    </p>
                  )}
                  {found && (
                    <div className="mt-3 overflow-hidden rounded-2xl border border-winter-100 bg-card">
                      {here && here.offDomain === null && found.length > 0 && (
                        <p className="border-b border-winter-100 px-3 py-2 text-xs text-foreground/55">Du plus proche au plus loin</p>
                      )}
                      <ul className="divide-y divide-winter-100">
                        {found.slice(0, SEARCH_RESULTS).map(({ entry: e, distance }) => {
                          const Icon = e.poi ? POI_ICONS[e.poi.category] : e.kind === 'other' ? SEARCH_ICONS.all : SEARCH_ICONS[e.kind];
                          const tint = e.poi ? CATEGORY.get(e.poi.category)!.color : e.kind === 'lift' ? '#7048e8' : '#386690';
                          return (
                            <li key={e.id} className="flex items-center gap-1 pr-2">
                              <button
                                type="button"
                                onClick={() => showEntry(e)}
                                className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-winter-50 focus-visible:bg-winter-50 focus-visible:outline-none"
                              >
                                {e.color ? (
                                  <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                                    <span className="h-3.5 w-3.5 rounded-full ring-4 ring-winter-50" style={{ backgroundColor: e.color }} />
                                  </span>
                                ) : (
                                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${tint}1a`, color: tint }}>
                                    <Icon className="h-4 w-4" aria-hidden />
                                  </span>
                                )}
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-semibold text-foreground">{e.name}</span>
                                  <span className="block truncate text-xs text-foreground/55">
                                    {e.sub}
                                    {distance !== null && ` · ${formatDistance(distance)}`}
                                  </span>
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => routeToEntry(e)}
                                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-semibold text-primary transition-colors hover:bg-winter-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                aria-label={`Itinéraire vers ${e.name}`}
                              >
                                <Navigation className="h-3.5 w-3.5" aria-hidden /> Y aller
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {found.length === 0 && <p className="px-3 py-5 text-center text-sm text-foreground/55">Aucun résultat.</p>}
                      {found.length > SEARCH_RESULTS && (
                        <p className="border-t border-winter-100 px-3 py-2.5 text-center text-xs text-foreground/55">
                          {found.length - SEARCH_RESULTS} autres résultats : précisez la recherche.
                        </p>
                      )}
                    </div>
                  )}
                </section>

                <section>
                  <h2 className={panelHeading}>Pistes affichées</h2>
                  <div className="grid grid-cols-2 gap-2">
                    {DIFFICULTIES.map((d) => {
                      const on = enabled.has(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDifficulty(d)}
                          aria-pressed={on}
                          className={`flex h-11 items-center gap-2.5 rounded-2xl border px-3 text-left text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                            on ? 'border-winter-200 bg-card text-foreground shadow-sm' : 'border-dashed border-winter-200 bg-transparent text-foreground/45'
                          }`}
                        >
                          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: PISTE_COLORS[d], opacity: on ? 1 : 0.3 }} />
                          {DIFFICULTY_LABELS[d]}
                          {stats && <span className="ml-auto text-xs font-medium tabular-nums text-foreground/50">{stats.byDifficulty[d]}</span>}
                        </button>
                      );
                    })}
                  </div>
                </section>

                {pois.length > 0 && (
                  <section>
                    <div className="mb-2 flex items-center justify-between">
                      <h2 className={`${panelHeading} !mb-0`}>Lieux sur la carte</h2>
                      <div className="flex gap-1">
                        <button type="button" onClick={() => setEnabledPois(new Set(DOMAIN_POI_CATEGORIES.map((c) => c.id)))} className={textButton}>
                          Tout
                        </button>
                        <button type="button" onClick={() => setEnabledPois(new Set())} className={textButton}>
                          Aucun
                        </button>
                      </div>
                    </div>

                    {POI_GROUPS.map((group) => {
                      const categories = group.categories.filter((c) => poiCounts.get(c.id));
                      if (!categories.length) return null;
                      return (
                        <div key={group.title} className="mt-4">
                          <h3 className="mb-1.5 px-1 text-xs font-medium text-foreground/55">{group.title}</h3>
                          <ul className="divide-y divide-winter-100 overflow-hidden rounded-2xl border border-winter-100 bg-card">
                            {categories.map((c) => {
                              const on = enabledPois.has(c.id);
                              const Icon = POI_ICONS[c.id];
                              return (
                                <li key={c.id}>
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={on}
                                    onClick={() => togglePoiCategory(c.id)}
                                    className="flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-winter-50 focus-visible:bg-winter-50 focus-visible:outline-none"
                                  >
                                    <span
                                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${on ? 'text-white' : 'bg-winter-50 text-foreground/40'}`}
                                      style={on ? { backgroundColor: c.color } : undefined}
                                    >
                                      <Icon className="h-4 w-4" aria-hidden />
                                    </span>
                                    <span className={`min-w-0 flex-1 truncate text-sm ${on ? 'font-semibold text-foreground' : 'text-foreground/55'}`}>{c.label}</span>
                                    <span className="text-xs tabular-nums text-foreground/45">{poiCounts.get(c.id)}</span>
                                    <SwitchKnob on={on} />
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })}
                  </section>
                )}

                <section>
                  <h2 className={panelHeading}>Affichage</h2>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={snow}
                    onClick={() => setSnow((v) => !v)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-winter-100 bg-card px-3 py-2 text-left transition-colors hover:bg-winter-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${snow ? 'bg-winter-600 text-white' : 'bg-winter-50 text-foreground/40'}`}>
                      <Snowflake className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${snow ? 'font-semibold text-foreground' : 'text-foreground/55'}`}>Montagnes enneigées</span>
                      <span className="block text-xs text-foreground/55">
                        {base === 'satellite' ? "Neige d'après l'altitude, sur la photo aérienne" : 'Sur la photo aérienne uniquement'}
                      </span>
                    </span>
                    <SwitchKnob on={snow} />
                  </button>
                </section>
              </div>
            )}
          </div>

          <p className="hidden items-start gap-2 border-t border-winter-100 bg-card/80 px-4 py-2.5 sm:flex text-xs leading-snug text-foreground/55">
            <MousePointer2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Clic droit ou Ctrl + glisser pour pivoter. Survolez une piste pour son nom, cliquez sur un lieu pour ses infos.
          </p>
        </aside>
      )}

      {/* Réglages de la vue */}
      {ready && (
        <div className={`absolute right-14 top-3 z-10 flex flex-wrap items-start gap-2 ${panelOpen ? 'left-3 sm:left-[372px]' : 'left-3'}`}>
          {!panelOpen && (
            <button type="button" onClick={() => setPanelOpen(true)} className={chip(true)}>
              <MapIcon className="h-3.5 w-3.5" /> {domain.name}
            </button>
          )}
          <button type="button" onClick={locate} className={chip(geoStatus === 'on' || geoStatus === 'searching')} aria-pressed={geoStatus === 'on'}>
            {geoStatus === 'searching' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5" />} Ma position
          </button>
          <button type="button" onClick={() => (routeOpen ? closeRoute() : openRoute())} className={chip(routeOpen)} aria-pressed={routeOpen}>
            <Navigation className="h-3.5 w-3.5" /> Itinéraire
          </button>
          <button type="button" onClick={() => showOverview()} className={chip(false)} title="Vue d'ensemble" aria-label="Vue d'ensemble">
            <Maximize2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Vue d&apos;ensemble</span>
          </button>
          <button type="button" onClick={() => setSpinning((s) => !s)} className={chip(spinning)} aria-pressed={spinning} title="Rotation" aria-label="Rotation">
            <RotateCw className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Rotation</span>
          </button>
          <button
            type="button"
            onClick={() => setBase((b) => (b === 'satellite' ? 'topo' : 'satellite'))}
            className={chip(false)}
            title={base === 'satellite' ? 'Plan IGN' : 'Photo aérienne'}
            aria-label={base === 'satellite' ? 'Plan IGN' : 'Photo aérienne'}
          >
            <Layers className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{base === 'satellite' ? 'Plan IGN' : 'Photo aérienne'}</span>
          </button>
          <button type="button" onClick={() => setShowLifts((v) => !v)} className={chip(showLifts)} aria-pressed={showLifts} title="Remontées" aria-label="Remontées">
            <Cable className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Remontées</span>
          </button>
          <button type="button" onClick={share} className={chip(false)} title="Partager cette vue" aria-label="Partager cette vue">
            <Share2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Partager</span>
          </button>
          {/* Risque d'avalanche du jour (bulletin du massif) : ouvre l'onglet Conditions. */}
          {live.data?.avalanche.risk ? (
            <button
              type="button"
              onClick={() => {
                setPanelOpen(true);
                setPanelTab('conditions');
              }}
              className="ml-auto inline-flex items-center gap-2 rounded-2xl border border-winter-200 bg-card/95 py-1 pl-1 pr-3 text-left shadow-sm transition hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              title="Voir le bulletin avalanche"
            >
              <AvalancheRiskIcon risk={live.data.avalanche.risk} className="h-9 w-9" />
              <span className="leading-tight">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/55">Avalanche</span>
                <span className="block text-xs font-semibold text-foreground">
                  {live.data.avalanche.risk}/5 · {RISK_LABELS[live.data.avalanche.risk]}
                  {live.data.demo && <span className="font-normal text-amber-700"> · simulé</span>}
                </span>
              </span>
            </button>
          ) : null}
        </div>
      )}

      {/* Guidage en cours */}
      {ready && routeOpen && navigating && (
        <NavigationBar route={shownRoute} gpsPending={!gpsStart} simulated={simulating} topClass="top-24 sm:top-16" onStop={stopNavigation} />
      )}

      {/* Itinéraire à ski */}
      {ready && routeOpen && !navigating && (
        <div className={`pointer-events-none absolute bottom-3 z-20 flex justify-center px-3 sm:bottom-16 ${panelOpen ? 'left-0 right-0 sm:left-[372px]' : 'left-0 right-0'}`}>
          <RouteCard
            hasStart={!!routeStart}
            startLabel={pickedStart ? 'Point choisi sur la carte' : 'Ma position'}
            gpsAvailable={!!gpsStart}
            picking={picking}
            onPickStart={() => {
              pickingRef.current = true;
              setPicking(true);
            }}
            onUseGps={() => setPickedStart(null)}
            goal={routeGoal}
            onGoal={setRouteGoal}
            villages={domain.valleys.flatMap((v) => v.villages.map((x) => x.name))}
            level={routeLevel}
            onLevel={setRouteLevel}
            status={routeStatus}
            result={route}
            closedCount={closedCount}
            onStart={startNavigation}
            onSimulate={startSimulation}
            onClose={closeRoute}
          />
        </div>
      )}

      {/* Fiche « Ma position » */}
      {ready && !routeOpen && geoStatus === 'on' && here && (
        <div className={`pointer-events-none absolute bottom-4 z-10 flex justify-center px-3 sm:bottom-16 ${panelOpen ? 'left-0 right-0 sm:left-[372px]' : 'left-0 right-0'}`}>
          <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-white/60 bg-card/95 p-4 text-sm shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 font-semibold text-foreground">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#1da1f2] opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#1da1f2]" />
                  </span>
                  Vous êtes ici
                </p>
                <p className="mt-0.5 text-xs text-foreground/50">
                  {here.altitude !== null && `${Math.round(here.altitude).toLocaleString('fr-FR')} m d'altitude · `}précision {formatDistance(here.accuracy)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={recenter} className="rounded-full px-2.5 py-1 text-xs font-semibold text-primary hover:bg-winter-50">
                  Centrer
                </button>
                <button type="button" onClick={() => setHere(null)} aria-label="Fermer" className="rounded-full p-1 text-foreground/40 hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {here.offDomain !== null ? (
              <p className="mt-3 text-xs text-foreground/60">Vous êtes à {formatDistance(here.offDomain)} des pistes les plus proches.</p>
            ) : (
              <ul className="mt-3 space-y-1.5 text-xs">
                {here.piste && (
                  <li className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PISTE_COLORS[here.piste.item.detail as PisteDifficulty] ?? PISTE_COLORS.unknown }} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-foreground">{here.piste.item.name}</span>
                      <span className="text-foreground/50"> · {DIFFICULTY_SINGULAR[here.piste.item.detail as PisteDifficulty] ?? 'Piste'}</span>
                    </span>
                    <span className="tabular-nums text-foreground/55">{formatDistance(here.piste.distance)}</span>
                  </li>
                )}
                {here.lift && (
                  <li className="flex items-center gap-2">
                    <Cable className="h-3 w-3 shrink-0 text-foreground/60" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-foreground">{here.lift.item.name}</span>
                      <span className="text-foreground/50"> · {LIFT_LABELS[here.lift.item.detail] ?? 'Remontée'}</span>
                    </span>
                    <span className="tabular-nums text-foreground/55">{formatDistance(here.lift.distance)}</span>
                  </li>
                )}
                {here.restaurant && (
                  <li>
                    <button type="button" onClick={() => showPoi(here.restaurant!.item)} className="flex w-full items-center gap-2 text-left hover:underline">
                      <span className="text-[11px] leading-none">🍽️</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{here.restaurant.item.name}</span>
                      <span className="tabular-nums text-foreground/55">{formatDistance(here.restaurant.distance)}</span>
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {notice && (
        // Pendant le guidage, le haut de l'écran est pris par la consigne : le message passe au-dessus de la barre du bas.
        <div
          role="status"
          className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-4 ${navigating ? 'bottom-24' : 'top-28 sm:top-16'}`}
        >
          <p className="max-w-md rounded-full bg-winter-900/90 px-4 py-2 text-center text-xs font-medium text-white shadow-lg">{notice}</p>
        </div>
      )}

      {/* Piste survolée et altitude sous le curseur : sans objet au doigt, masqué sur mobile */}
      {ready && (
        <div
          className={`pointer-events-none absolute bottom-4 z-10 hidden justify-center sm:flex ${panelOpen ? 'left-0 right-0 sm:left-[372px]' : 'left-0 right-0'}`}
        >
          <div className="flex items-center gap-3 rounded-full border border-white/60 bg-card/95 px-4 py-2 text-xs shadow-lg">
            {hover && (
              <span className="flex items-center gap-2 border-r border-winter-200 pr-3">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: hover.color }} />
                <span className="font-semibold text-foreground">{hover.title}</span>
                <span className="text-foreground/55">{hover.detail}</span>
                {hover.live && <span className={`font-semibold ${hover.live.open ? 'text-emerald-700' : 'text-foreground/55'}`}>{hover.live.text}</span>}
              </span>
            )}
            <span className="flex items-center gap-1.5 text-foreground/55">
              <Box className="h-3.5 w-3.5" /> Altitude
              <span ref={altitudeRef} className="min-w-[4.5ch] font-semibold tabular-nums text-foreground">
                —
              </span>
            </span>
          </div>
        </div>
      )}

      {(!ready || booting) && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-winter-900 to-[#16324a] p-6 text-center text-white">
          {(status === 'loading' || booting) && (
            <div className="w-full max-w-xs">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/45">Carte 3D</p>
              <p className="mt-2 font-display text-3xl">{domain.name}</p>
              <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-white/80 transition-all duration-500" style={{ width: `${Math.max(6, (boot.length / BOOT_STEPS.length) * 100)}%` }} />
              </div>
              <ul className="mt-5 space-y-1.5 text-left text-sm">
                {BOOT_STEPS.map((step) => {
                  const done = boot.includes(step.id);
                  const current = !done && BOOT_STEPS.find((s) => !boot.includes(s.id))?.id === step.id;
                  return (
                    <li key={step.id} className={`flex items-center gap-2.5 ${done ? 'text-white/80' : current ? 'text-white' : 'text-white/35'}`}>
                      {done ? (
                        <Check className="h-4 w-4 shrink-0 text-emerald-300" />
                      ) : current ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                      ) : (
                        <span className="h-4 w-4 shrink-0 rounded-full border border-white/25" />
                      )}
                      {step.label}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {status === 'missing' && <p className="text-sm text-white/70">Le tracé du domaine n&apos;est pas encore disponible.</p>}
          {status === 'error' && <p className="text-sm text-white/70">Impossible de charger la carte 3D. Réessayez plus tard.</p>}
          {status === 'nowebgl' && (
            <p className="max-w-sm text-sm text-white/70">Votre navigateur ne permet pas l&apos;affichage 3D (WebGL désactivé ou non pris en charge).</p>
          )}
          {status !== 'loading' && !booting && !embedded && SEARCH_SITE_URL && (
            <a href={SEARCH_SITE_URL} className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-white/30 px-4 py-2 text-sm font-semibold hover:bg-white/10">
              <ArrowLeft className="h-4 w-4" /> Retour à AltiStay
            </a>
          )}
        </div>
      )}
    </div>
  );
}
