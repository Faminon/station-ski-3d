// Carte 3D d'un domaine en Three.js : moteur WebGPU (WebGL 2 à défaut, automatiquement).
//
// Chargement : altitudes, puis maillage du relief, tracés, sapins, et enfin photos
// aériennes, tuile par tuile depuis le centre. Rendu à la demande : rien n'est
// redessiné tant que la vue ne bouge pas (comme MapLibre), sauf en rotation automatique
// ou pendant un déplacement animé (flyTo).
//
// Réglages dans l'adresse (essais) : ?webgl force WebGL 2, ?maillage=256 affine le
// relief du domaine (128 mailles par tuile par défaut), ?aa active l'anticrénelage.

import * as THREE from 'three/webgpu';
import { color, mix, normalWorld, smoothstep } from 'three/tsl';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { domainDetailBounds } from '@/lib/domainArea';
import type { SkiDomainConfig } from '@/lib/skiDomains';
import type { DomainData, TrackLine } from './domainData';
import { loadElevation } from './elevation';
import { buildForest, type Forest } from './forest';
import { EXAGGERATION, makeFrame, tilesCovering } from './geo';
import { buildPeakLabels, buildRoadLayer, buildRouteLayer, buildTrackLayer, type RouteStepLine } from './overlays';
import { buildChunk, parksShown, winter, type Chunk } from './terrain';
import { installTouchGestures } from './touchGestures';
import { parkLabelPoints, parkOverlay } from './parks';
import { parkZoneFeatures } from '@/components/domain/parkZones';
import { parkFeatureVolumes } from '@/components/domain/parkFeatures';
import { buildLiftMesh, buildLiftVehicles, buildPlaceMeshes, buildVolumeMesh, loadVillageMesh } from './buildings';
import { mountainPlaces, placeClearings } from '@/components/domain/mountainBuildings';

export interface SceneStats {
  backend: string;
  /** Images par seconde en mouvement (0 au repos). */
  fps: number;
  /** Part des images sous 40 par seconde, sur la dernière demi-seconde de mouvement. */
  slowShare: number;
  trees: number;
  triangles: number;
  drawCalls: number;
}

export interface SceneOptions {
  forceWebGL: boolean;
  segments: number;
  antialias: boolean;
}

/** Vue : point visé, distance de la caméra (m), inclinaison depuis la verticale et cap (degrés, 180 = vers le sud). */
export interface ViewTarget {
  lng: number;
  lat: number;
  distance?: number;
  pitch?: number;
  bearing?: number;
  /** Durée du déplacement (ms) ; 0 : immédiat. */
  duration?: number;
}

export interface LabelHandle {
  setLngLat(lng: number, lat: number): void;
  setVisible(visible: boolean): void;
  remove(): void;
}

export interface PickEvent {
  lng: number;
  lat: number;
  /** Distance de la caméra au point touché (m) : sert à régler la tolérance du clic. */
  distance: number;
}

export interface SceneHandle {
  setWinter(on: boolean): void;
  setRotate(on: boolean): void;
  flyTo(view: ViewTarget): void;
  /** Vue d'ensemble du domaine. */
  overview(): void;
  /** Point de la carte → écran (px dans le conteneur), ou null s'il est derrière la caméra. */
  project(lng: number, lat: number, lift?: number): { x: number; y: number } | null;
  /**
   * Étiquette HTML posée sur le relief ; masquée au-delà de `maxDistance` (m) de la caméra.
   * `smooth` : glisse vers chaque nouvelle position au lieu d'y sauter (position GPS).
   */
  addLabel(el: HTMLElement, lng: number, lat: number, options?: { lift?: number; maxDistance?: number; anchorBottom?: boolean; smooth?: boolean }): LabelHandle;
  /**
   * Guidage : la caméra suit ce point en continu, en douceur (sans à-coups entre deux positions
   * GPS), tournée selon `bearing` ; null arrête le suivi. Un geste sur la carte le suspend un moment.
   */
  follow(target: { lng: number; lat: number; bearing?: number } | null): void;
  setClosedTracks(pistes: Set<number>, lifts: Set<number>): void;
  setHighlight(tracks: TrackLine[] | null): void;
  /** Itinéraire affiché (ou rien) ; en guidage, le reste du domaine est grisé. */
  setRoute(steps: RouteStepLine[] | null, guiding: boolean): void;
  /** Catégories de lieux cochées : leurs bâtiments 3D sont affichés. */
  setPlaceCategories(categories: Set<string>): void;
  /** Altitude réelle (m) d'un point, null hors des tuiles chargées (réseau des itinéraires). */
  elevation(lng: number, lat: number): number | null;
  /** Clic (ou toucher) sur le relief, sans glisser. */
  onPick(callback: (e: PickEvent) => void): void;
  /** Appelé après chaque image dessinée (bulles qui suivent la carte). */
  onFrame(callback: () => void): () => void;
  dispose(): void;
}

const SKY = '#7fb8e6';
const FOG = '#e4f1fb';
/** Cadre autour du centre : même étendue que la carte MapLibre (maxBounds), un peu réduite. */
const WIDE_LNG = 0.5;
const WIDE_LAT = 0.35;
/**
 * Horizon : un anneau de relief très grossier bien plus large (~250 × 260 km), noyé dans le
 * brouillard. Où que soit la caméra (bornée, voir constrainView), le bord du monde est toujours
 * plus loin que la fin du brouillard : on ne voit jamais le vide.
 */
const HORIZON_LNG = 1.6;
const HORIZON_LAT = 1.2;
/** Brouillard : début et fin (m). Le ciel se fond dans la même couleur à l'horizon. */
const FOG_NEAR = 20_000;
const FOG_FAR = 55_000;
/** Point visé : au plus à cette distance de la zone détaillée du domaine (m). */
const TARGET_MARGIN = 4000;
/** Caméra : au plus à cette distance du centre, à l'horizontale (m). */
const CAMERA_RADIUS = 30_000;
/** Altitude minimale de la caméra au-dessus du sol (m). */
const CAMERA_CLEARANCE = 80;
const OVERVIEW_DISTANCE = 15_000;
/** Recul maximal (m) sur un écran en hauteur : on voit tout juste Risoul et Vars les Claux ensemble. */
const MAX_DISTANCE = 16_000;
/**
 * Sur un écran en largeur (ordinateur), on voit plus large à la même distance : le recul est
 * réduit d'autant, pour que la plus grande étendue visible reste celle d'un téléphone.
 */
const aspectFactor = (aspect: number) => 1 / Math.max(1, aspect);
const OVERVIEW_PITCH = 52;

/** Vue du guidage : caméra proche, derrière le skieur. */
const FOLLOW_DISTANCE = 650;
const FOLLOW_PITCH = 58;
/** Temps de réponse du lissage (s) : position de la caméra et du repère, puis cap. */
const SMOOTH_POSITION_S = 0.6;
const SMOOTH_BEARING_S = 0.9;
/** Après un geste sur la carte pendant le guidage, la caméra reprend le suivi au bout de… (ms). */
const FOLLOW_RESUME_MS = 6000;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function createScene(
  container: HTMLElement,
  domain: SkiDomainConfig,
  data: DomainData,
  options: SceneOptions,
  /** Étape du chargement et avancement (0 à 1) ; `null` : la carte est prête et fluide. */
  onProgress: (label: string | null, fraction: number) => void,
  onStats: (stats: SceneStats) => void,
): Promise<SceneHandle> {
  const abort = new AbortController();
  /** Une image est à redessiner (rendu à la demande). */
  let dirty = true;
  const [lng0, lat0] = domain.center;
  const frame = makeFrame(lng0, lat0);
  const { pistes, forests } = data;

  const detailBounds = domainDetailBounds(pistes, 2);
  const wideBounds: [number, number, number, number] = [lng0 - WIDE_LNG, lat0 - WIDE_LAT, lng0 + WIDE_LNG, lat0 + WIDE_LAT];
  const detailTiles = tilesCovering(detailBounds, 13);
  const farTiles = tilesCovering(wideBounds, 11);
  const horizonBounds: [number, number, number, number] = [lng0 - HORIZON_LNG, lat0 - HORIZON_LAT, lng0 + HORIZON_LNG, lat0 + HORIZON_LAT];
  const horizonTiles = tilesCovering(horizonBounds, 9);

  // Avancement : données 0–5 % (ThreeViewer), relief 5–35 %, maillage et objets 35–60 %,
  // photos aériennes du domaine 60–92 %, mise en route (images régulières) 92–100 %.
  /** Laisse le navigateur afficher l'avancement entre deux gros calculs (au plus tous les 60 ms). */
  let lastYield = performance.now();
  const breathe = async () => {
    if (performance.now() - lastYield < 60) return;
    await new Promise<void>((resolve) => {
      // Onglet en arrière-plan : pas d'image à attendre, on continue quand même.
      const t = setTimeout(resolve, 50);
      requestAnimationFrame(() => {
        clearTimeout(t);
        setTimeout(resolve, 0);
      });
    });
    lastYield = performance.now();
  };
  const step = async (label: string, fraction: number) => {
    onProgress(label, fraction);
    lastYield = 0;
    await breathe();
  };

  const elevLevels = [
    { zoom: 14, tiles: tilesCovering(detailBounds, 14) },
    { zoom: 11, tiles: farTiles },
    { zoom: 9, tiles: horizonTiles },
  ];
  const elevTotal = elevLevels.reduce((n, l) => n + l.tiles.length, 0);
  let elevDone = 0;
  onProgress('Relief', 0.05);
  const elev = await loadElevation(frame, elevLevels, () => onProgress('Relief', 0.05 + (0.3 * ++elevDone) / elevTotal));
  const ground = (x: number, z: number) => elev.atOr0(x, z) * EXAGGERATION;

  // ---- Moteur ------------------------------------------------------------------------------
  const renderer = new THREE.WebGPURenderer({ antialias: options.antialias, forceWebGL: options.forceWebGL, powerPreference: 'high-performance' });
  // Écrans très denses : rendu plafonné à ×2, comme la carte MapLibre.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  await renderer.init();
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL 2';

  const labels = new CSS2DRenderer();
  labels.setSize(container.clientWidth, container.clientHeight);
  Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  // Ciel : couleur du brouillard à l'horizon, bleu en montant (le relief lointain s'y fond).
  scene.backgroundNode = mix(color(FOG), color(SKY), smoothstep(0, 0.45, normalWorld.y));
  scene.fog = new THREE.Fog(FOG, FOG_NEAR, FOG_FAR);

  // Lumière rasante venant toujours du haut à gauche de l'écran, comme l'ombrage de la carte
  // MapLibre (« viewport ») : elle tourne avec la caméra (voir syncSun). Fixe au nord-ouest, la vue
  // depuis le nord ne montrait que des versants également éclairés : neige toute plate. Le ciel
  // bleuté éclaire les versants à l'ombre (intensités « physiques » : × π pour un blanc franc).
  const sun = new THREE.DirectionalLight('#fff6ea', 1.05 * Math.PI);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#c3d6f5', '#5d6f91', 0.42 * Math.PI));

  // ---- Relief ------------------------------------------------------------------------------
  await step('Maillage du relief', 0.35);
  const forestPolygons: number[][][][] = [];
  for (const f of forests.features) {
    if (f.geometry.type === 'Polygon') forestPolygons.push(f.geometry.coordinates);
    else if (f.geometry.type === 'MultiPolygon') forestPolygons.push(...f.geometry.coordinates);
  }
  const maxAnisotropy = renderer.getMaxAnisotropy();
  // Snowparks et zones ludiques : emprises d'OpenStreetMap, ou zone autour de leur point.
  const parkZones = parkZoneFeatures(data.parkZones, data.pois);
  const paintParks = parkOverlay(parkZones);
  const chunks: Chunk[] = [];
  const chunkTotal = detailTiles.length + farTiles.length + horizonTiles.length;
  /** Une tuile de relief maillée : avancement, et une pause de temps en temps pour l'afficher. */
  const meshed = async () => {
    onProgress('Maillage du relief', 0.35 + (0.12 * chunks.length) / chunkTotal);
    await breathe();
  };
  for (const [x, y] of detailTiles) {
    chunks.push(buildChunk(frame, elev, { z: 13, x, y, segments: options.segments, textureZoom: 15, drop: 0 }, maxAnisotropy, forestPolygons, paintParks));
    await meshed();
  }
  const detailChunks = [...chunks];
  // Emprises couvertes par chaque niveau (unions de tuiles : des rectangles), que le niveau plus
  // grossier ne redessine pas.
  const rectOf = (z: number, tiles: [number, number][]): [number, number, number, number] => {
    const rects = tiles.map(([x, y]) => frame.tileRect(z, x, y));
    return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
  };
  const detailRect = rectOf(13, detailTiles);
  const farRect = rectOf(11, farTiles);
  for (const [x, y] of farTiles) {
    chunks.push(buildChunk(frame, elev, { z: 11, x, y, segments: 64, textureZoom: 12, drop: 12, exclude: detailRect }, maxAnisotropy, forestPolygons));
    await meshed();
  }
  // Horizon : tuiles 9 hors du cadre (sous les tuiles 11 là où elles se recouvrent).
  for (const [x, y] of horizonTiles) {
    chunks.push(buildChunk(frame, elev, { z: 9, x, y, segments: 64, textureZoom: 10, drop: 40, exclude: farRect }, maxAnisotropy, []));
    await meshed();
  }
  for (const c of chunks) {
    c.mesh.updateMatrix();
    scene.add(c.mesh);
  }
  const pickable = chunks.map((c) => c.mesh);

  // ---- Tracés, sommets, sapins ---------------------------------------------------------------
  await step('Pistes et remontées', 0.47);
  const tracks = buildTrackLayer(frame, elev, data.tracks);
  scene.add(tracks.group);
  // Routes et rues, sous les pistes ; rues des villages seulement de près.
  const roads = buildRoadLayer(frame, elev, data.roads);
  scene.add(roads.group);
  /** Rues masquées au-delà de cette distance de la caméra au point visé (m). */
  const STREETS_MAX_M = 7000;
  const route = buildRouteLayer(frame, elev);
  scene.add(route.group);
  scene.add(buildPeakLabels(frame, elev, pistes));

  // Lieux modélisés (restaurants, refuges, toilettes…), hors des villages dont on a les bâtiments.
  const places = mountainPlaces(data.pois, data.builtAreas);

  await step('Sapins', 0.5);
  const forest: Forest = buildForest(
    frame,
    elev,
    forests,
    [
      ...data.tracks.pistes.map((p) => ({ coordinates: p.coordinates, halfWidth: 16 })),
      ...data.tracks.lifts.map((l) => ({ coordinates: l.coordinates, halfWidth: 7 })),
      // Pas de sapin à travers un chalet ou un belvédère.
      ...placeClearings(places),
    ],
    detailChunks,
  );
  scene.add(forest.group);

  // ---- Bâtiments et remontées en 3D -----------------------------------------------------------
  // Comme sur la carte MapLibre : affichés de près seulement, et grossis quand on s'éloigne
  // (échelle k par demi-paliers, recalculée une fois la vue posée).
  await step('Bâtiments et remontées', 0.54);
  const models = new THREE.Group();
  scene.add(models);
  let placeMeshes = new Map<string, THREE.Mesh>();
  let liftMesh: THREE.Mesh | null = null;
  /** Gares, pylônes et câbles affichés (de près seulement, voir syncModels). */
  let liftsShown = true;
  let modelK = 0;
  let placeCategories = new Set<string>();
  const disposeMesh = (m: THREE.Mesh) => {
    models.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  };
  const buildModels = (k: number) => {
    if (k === modelK) return;
    modelK = k;
    placeMeshes.forEach(disposeMesh);
    if (liftMesh) disposeMesh(liftMesh);
    placeMeshes = buildPlaceMeshes(frame, elev, places, k);
    // `models` garde les véhicules : on ne retire que ce qu'on reconstruit.
    placeMeshes.forEach((m, cat) => {
      m.visible = placeCategories.has(cat);
      models.add(m);
    });
    liftMesh = buildLiftMesh(frame, elev, data.tracks.lifts, k);
    liftMesh.visible = liftsShown;
    models.add(liftMesh);
    dirty = true;
  };
  // Modules des snowparks (sauts, rails, box, entrée), à l'écart des remontées.
  const parkMesh = buildVolumeMesh(
    frame,
    elev,
    parkFeatureVolumes(
      parkZones,
      data.tracks.lifts.map((l) => l.coordinates),
      (lng, lat) => {
        const [x, z] = frame.toXZ(lng, lat);
        return elev.at(x, z);
      },
    ),
  );
  models.add(parkMesh);

  // Véhicules des remontées, animés tant qu'on les voit (voir la boucle de rendu).
  const vehicles = buildLiftVehicles(frame, elev, data.tracks.lifts);
  models.add(vehicles.mesh);
  let closedLifts = new Set<number>();

  /** Échelle des modèles selon la distance de la caméra au point visé (1 de près, 4 au plus). */
  const modelScale = (distance: number) => Math.min(4, Math.max(1, 2 ** (Math.round(2 * Math.log2(distance / 1500)) / 2)));
  // Bâtiments réels des villages : chargés en arrière-plan.
  const villages = new THREE.Group();
  scene.add(villages);
  void loadVillageMesh(frame, elev, data.villageIds).then((mesh) => {
    if (!mesh || abort.signal.aborted) return;
    villages.add(mesh);
    dirty = true;
  });

  // ---- Caméra ------------------------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 20, 90_000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false;
  controls.minDistance = 250;
  // Recul maximal : selon la forme de l'écran (voir aspectFactor).
  controls.maxDistance = MAX_DISTANCE * aspectFactor(camera.aspect);
  /** Vue d'ensemble : un peu en deçà du recul maximal. */
  const overviewDistance = () => OVERVIEW_DISTANCE * aspectFactor(camera.aspect);
  controls.maxPolarAngle = rad(78);
  controls.autoRotateSpeed = 1.5;

  /** Place la caméra : point visé, distance, inclinaison et cap. */
  const placeCamera = (tx: number, tz: number, distance: number, pitch: number, bearing: number) => {
    const ty = ground(tx, tz);
    const p = rad(pitch);
    const b = rad(bearing);
    controls.target.set(tx, ty, tz);
    camera.position.set(tx - Math.sin(b) * distance * Math.sin(p), ty + distance * Math.cos(p), tz + Math.cos(b) * distance * Math.sin(p));
    camera.lookAt(controls.target);
  };
  /**
   * Soleil en haut à gauche de l'écran, quel que soit le cap : devant la caméra et à sa gauche,
   * à ~31° au-dessus de l'horizon (relief lisible dans toutes les directions).
   */
  const syncSun = () => {
    const off = camera.position.clone().sub(controls.target);
    const b = Math.atan2(-off.x, off.z);
    sun.position.set(Math.sin(b) - Math.cos(b), 0.85, -Math.cos(b) - Math.sin(b));
  };

  /** Vue actuelle : point visé, distance, inclinaison et cap. */
  const currentView = () => {
    const off = camera.position.clone().sub(controls.target);
    const distance = off.length();
    return {
      x: controls.target.x,
      z: controls.target.z,
      distance,
      pitch: deg(Math.acos(Math.min(1, off.y / distance))),
      bearing: deg(Math.atan2(-off.x, off.z)),
    };
  };
  placeCamera(0, 0, overviewDistance(), OVERVIEW_PITCH, domain.overviewBearing);
  controls.update();
  buildModels(modelScale(overviewDistance()));

  /** Modèles 3D : masqués au-delà de ~9 km (zoom 13 de la carte MapLibre), bâtiments des villages au-delà de 14 km. */
  const MODELS_MAX_M = 9000;
  const VILLAGES_MAX_M = 14000;
  /**
   * Remontées en 3D (télésièges, télécabines, tire-fesses) : de loin, il ne reste que leur trait
   * au sol. Véhicules masqués au-delà de VEHICLES_MAX_M, puis gares, pylônes et câbles au-delà de
   * LIFTS_MAX_M. Distances ramenées à un écran en hauteur (voir aspectFactor) : sur un ordinateur,
   * on voit aussi large d'un peu plus près, les remontées s'effacent donc plus tôt.
   */
  const VEHICLES_MAX_M = 7000;
  const LIFTS_MAX_M = 10_000;
  let vehiclesShown = true;
  let scaleTimer: ReturnType<typeof setTimeout> | undefined;
  const syncModels = () => {
    const d = camera.position.distanceTo(controls.target);
    models.visible = d < MODELS_MAX_M;
    villages.visible = d < VILLAGES_MAX_M;
    const seen = d / aspectFactor(camera.aspect);
    liftsShown = seen < LIFTS_MAX_M;
    vehiclesShown = seen < VEHICLES_MAX_M;
    if (liftMesh) liftMesh.visible = liftsShown;
    // Nouvelle échelle une fois la vue posée (jamais pendant un geste).
    clearTimeout(scaleTimer);
    if (models.visible) scaleTimer = setTimeout(() => buildModels(modelScale(camera.position.distanceTo(controls.target))), 250);
  };

  // ---- Déplacements animés ---------------------------------------------------------------------
  let anim: { from: ReturnType<typeof currentView>; to: ReturnType<typeof currentView>; start: number; duration: number } | null = null;
  const flyTo = (view: ViewTarget) => {
    const from = currentView();
    const [x, z] = frame.toXZ(view.lng, view.lat);
    let bearing = view.bearing ?? from.bearing;
    // Le plus court chemin pour tourner.
    while (bearing - from.bearing > 180) bearing -= 360;
    while (bearing - from.bearing < -180) bearing += 360;
    const to = { x, z, distance: view.distance ?? from.distance, pitch: view.pitch ?? from.pitch, bearing };
    const duration = view.duration ?? 1800;
    if (duration <= 0) {
      placeCamera(to.x, to.z, to.distance, to.pitch, to.bearing);
      dirty = true;
      return;
    }
    anim = { from, to, start: performance.now(), duration };
    controls.autoRotate = false;
    dirty = true;
  };
  const stepAnim = (now: number) => {
    if (!anim) return;
    const t = Math.min(1, (now - anim.start) / anim.duration);
    const k = ease(t);
    const { from, to } = anim;
    // Distance : interpolation géométrique, la caméra prend de la hauteur pour les longs trajets.
    const travel = Math.hypot(to.x - from.x, to.z - from.z);
    const arc = Math.sin(Math.PI * k) * Math.min(travel * 0.4, 6000);
    const distance = from.distance * (to.distance / from.distance) ** k + arc;
    placeCamera(from.x + (to.x - from.x) * k, from.z + (to.z - from.z) * k, distance, from.pitch + (to.pitch - from.pitch) * k, from.bearing + (to.bearing - from.bearing) * k);
    if (t >= 1) anim = null;
  };
  // ---- Suivi du skieur (guidage) ---------------------------------------------------------------
  let follow: { x: number; z: number; bearing: number | null } | null = null;
  let followPausedUntil = 0;
  /** Approche exponentielle de la vue de guidage ; vrai tant qu'elle n'est pas atteinte. */
  const stepFollow = (dt: number, now: number): boolean => {
    if (!follow || now < followPausedUntil) return false;
    const cur = currentView();
    const a = 1 - Math.exp(-dt / SMOOTH_POSITION_S);
    const ab = 1 - Math.exp(-dt / SMOOTH_BEARING_S);
    let db = (follow.bearing ?? cur.bearing) - cur.bearing;
    db = ((((db + 180) % 360) + 360) % 360) - 180;
    const dx = follow.x - cur.x;
    const dz = follow.z - cur.z;
    const dd = FOLLOW_DISTANCE - cur.distance;
    const dp = FOLLOW_PITCH - cur.pitch;
    placeCamera(cur.x + dx * a, cur.z + dz * a, cur.distance + dd * a, cur.pitch + dp * a, cur.bearing + db * ab);
    return Math.hypot(dx, dz) > 0.3 || Math.abs(db) > 0.1 || Math.abs(dd) > 1 || Math.abs(dp) > 0.1;
  };

  // Un geste de l'utilisateur interrompt le déplacement, et le suivi pour un moment.
  controls.addEventListener('start', () => {
    anim = null;
    if (follow) followPausedUntil = performance.now() + FOLLOW_RESUME_MS;
  });

  // ---- Étiquettes ------------------------------------------------------------------------------
  const labelGroup = new THREE.Group();
  scene.add(labelGroup);
  const limited = new Map<CSS2DObject, number>();
  /** Étiquettes qui glissent vers leur nouvelle position (repère GPS). */
  const gliding = new Map<CSS2DObject, THREE.Vector3>();
  const stepLabels = (dt: number): boolean => {
    const a = 1 - Math.exp(-dt / SMOOTH_POSITION_S);
    let moving = false;
    for (const [obj, goal] of gliding) {
      if (obj.position.distanceTo(goal) < 0.05) continue;
      obj.position.lerp(goal, a);
      moving = true;
    }
    return moving;
  };
  const addLabel: SceneHandle['addLabel'] = (el, lng, lat, opts = {}) => {
    const obj = new CSS2DObject(el);
    const lift = opts.lift ?? 0;
    const goal = new THREE.Vector3();
    const place = (lo: number, la: number, first = false) => {
      const [x, z] = frame.toXZ(lo, la);
      goal.set(x, ground(x, z) + lift, z);
      // Glissement, sauf au premier placement ou pour un saut de plus de 500 m (nouveau départ).
      if (!opts.smooth || first || obj.position.distanceTo(goal) > 500) obj.position.copy(goal);
    };
    place(lng, lat, true);
    if (opts.smooth) gliding.set(obj, goal);
    if (opts.anchorBottom) obj.center.set(0.5, 1);
    if (opts.maxDistance) limited.set(obj, opts.maxDistance);
    labelGroup.add(obj);
    dirty = true;
    return {
      setLngLat(lo, la) {
        place(lo, la);
        dirty = true;
      },
      setVisible(visible) {
        obj.visible = visible;
        dirty = true;
      },
      remove() {
        labelGroup.remove(obj);
        limited.delete(obj);
        gliding.delete(obj);
        el.remove();
        dirty = true;
      },
    };
  };
  const cullLabels = () => {
    for (const [obj, max] of limited) {
      // Trop loin : masquée sans la retirer (setVisible, lui, la retire de l'affichage).
      obj.element.style.visibility = camera.position.distanceTo(obj.position) > max ? 'hidden' : '';
    }
  };

  // Noms des parcs, en capitales orange (comme la carte MapLibre), jusqu'à ~12 km.
  const parkLabels = parkLabelPoints(parkZones).map((p) => {
    const el = document.createElement('div');
    el.className = 'three-park';
    el.textContent = p.label.toUpperCase();
    return addLabel(el, p.lng, p.lat, { lift: 20, maxDistance: 12_000 });
  });

  // Numéros des grandes routes (D902…), en petites étiquettes, jusqu'à ~15 km.
  for (const r of roads.refs) {
    const el = document.createElement('div');
    el.className = 'three-road-ref';
    el.textContent = r.ref;
    addLabel(el, r.lng, r.lat, { lift: 6, maxDistance: 15_000 });
  }

  // ---- Sélection au clic ----------------------------------------------------------------------
  const pickCallbacks: ((e: PickEvent) => void)[] = [];
  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number; t: number } | null = null;
  /** Dernière image où la vue bougeait (glissé amorti de la souris). */
  let viewMovedAt = 0;
  const onDown = (e: PointerEvent) => {
    // Clic pendant que la vue glisse encore : il l'arrête, sans rien ouvrir.
    down = performance.now() - viewMovedAt < 120 ? null : { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  // Un glisser qui revient près du départ n'est pas un clic.
  const onMovePick = (e: PointerEvent) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down = null;
  };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 500) return;
    down = null;
    pickAt(e.clientX, e.clientY);
  };
  /** Sélection au point d'écran (clic de souris, ou toucher reconnu par touchGestures). */
  const pickAt = (clientX: number, clientY: number) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickable, false)[0];
    if (!hit) return;
    const [lng, lat] = frame.toLngLat(hit.point.x, hit.point.z);
    for (const cb of pickCallbacks) cb({ lng, lat, distance: hit.distance });
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMovePick);
  renderer.domElement.addEventListener('pointerup', onUp);

  // ---- Gestes tactiles (téléphone) : comme Google Maps / Plans ----------------------------------
  // MapControls garde la souris et le trackpad ; au doigt, touchGestures prend la main.
  const gestures = installTouchGestures({
    element: renderer.domElement,
    camera,
    view: currentView,
    setView(v) {
      placeCamera(v.x, v.z, Math.min(controls.maxDistance, Math.max(controls.minDistance, v.distance)), Math.min(78, Math.max(0, v.pitch)), v.bearing);
      constrainView();
      controls.update();
      dirty = true;
    },
    animateTo(v) {
      const [lng, lat] = frame.toLngLat(v.x, v.z);
      flyTo({ lng, lat, distance: v.distance, pitch: v.pitch, bearing: v.bearing, duration: 350 });
    },
    targetY: () => controls.target.y,
    onStart() {
      anim = null;
      controls.autoRotate = false;
      if (follow) followPausedUntil = performance.now() + FOLLOW_RESUME_MS;
    },
    onTap: (x, y) => pickAt(x, y),
    minDistance: controls.minDistance,
    get maxDistance() {
      return controls.maxDistance;
    },
    maxPitch: 78,
  });

  // ---- Boucle de rendu ---------------------------------------------------------------------
  const frameTimes: number[] = [];
  let lastFrame = 0;
  let lastStats = 0;
  let treesDrawn = 0;
  const frameCallbacks = new Set<() => void>();

  // Zone où le point visé peut aller : le domaine et une marge (on ne part pas « s'échapper »).
  const [ax0, az0] = frame.toXZ(detailBounds[0], detailBounds[3]);
  const [ax1, az1] = frame.toXZ(detailBounds[2], detailBounds[1]);
  const targetBox = { x0: ax0 - TARGET_MARGIN, x1: ax1 + TARGET_MARGIN, z0: az0 - TARGET_MARGIN, z1: az1 + TARGET_MARGIN };

  /**
   * Garde la vue dans la carte : point visé dans le domaine (avec la caméra qui le suit, sans
   * tourner), caméra à moins de CAMERA_RADIUS du centre, et jamais sous le relief.
   */
  const constrainView = () => {
    const t = controls.target;
    const cx = Math.min(targetBox.x1, Math.max(targetBox.x0, t.x)) - t.x;
    const cz = Math.min(targetBox.z1, Math.max(targetBox.z0, t.z)) - t.z;
    if (cx || cz) {
      t.x += cx;
      t.z += cz;
      camera.position.x += cx;
      camera.position.z += cz;
    }
    // Le point visé suit le relief (rotation autour du sol).
    const dy = ground(t.x, t.z) - t.y;
    t.y += dy;
    camera.position.y += dy;
    // Caméra trop loin du centre : rapprochée du point visé, dans la même direction.
    const r = Math.hypot(camera.position.x, camera.position.z);
    if (r > CAMERA_RADIUS) {
      const off = camera.position.clone().sub(t);
      // Plus grande fraction du recul horizontal qui ramène la caméra dans le cercle.
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (Math.hypot(t.x + (off.x * mid), t.z + (off.z * mid)) <= CAMERA_RADIUS) lo = mid;
        else hi = mid;
      }
      camera.position.copy(t).addScaledVector(off, lo);
    }
    const floor = ground(camera.position.x, camera.position.z) + CAMERA_CLEARANCE;
    if (camera.position.y < floor) camera.position.y = floor;
  };

  /** Des véhicules de remontée avancent à l'écran (image précédente). */
  let liftsMoving = false;

  // ---- Mise en route : la carte n'est montrée qu'une fois fluide --------------------------------
  /** Images de suite à cadence régulière avant de montrer la carte. */
  const WARM_FRAMES = 12;
  /** Au plus (ms) : un appareil lent ne reste pas bloqué sur l'écran de chargement. */
  const WARM_MAX_MS = 4000;
  let warm: { start: number; last: number; times: number[]; done: () => void } | null = null;
  /**
   * Dessine la carte en continu (sous l'écran de chargement) jusqu'à ce que les images s'enchaînent
   * à cadence régulière : textures envoyées à la carte graphique, sapins posés, à-coups passés.
   */
  const warmUp = () =>
    new Promise<void>((done) => {
      warm = { start: performance.now(), last: 0, times: [], done };
      dirty = true;
    });
  const stepWarm = (now: number) => {
    const w = warm!;
    if (w.last) w.times.push(now - w.last);
    w.last = now;
    const recent = w.times.slice(-WARM_FRAMES);
    const sorted = [...recent].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
    // Régulière : aucune image bien plus longue que les autres (plus d'à-coups). Un appareil lent
    // n'ira pas plus vite en attendant : c'est la régularité qu'on attend, pas une cadence donnée.
    const steady = recent.filter((t) => t < Math.max(20, median * 1.5)).length;
    onProgress('Mise en route', 0.92 + 0.08 * (steady / WARM_FRAMES));
    if ((recent.length === WARM_FRAMES && steady === WARM_FRAMES) || now - w.start > WARM_MAX_MS) {
      warm = null;
      w.done();
    }
  };

  let lastLoop = 0;
  const loop = (now: number) => {
    const dt = lastLoop ? Math.min(0.1, (now - lastLoop) / 1000) : 0.016;
    lastLoop = now;
    // Remontées proches à l'écran : leurs véhicules avancent, l'image est redessinée en continu.
    // De loin (ou hors champ), plus aucun véhicule : la carte se repose tant que la vue ne bouge pas.
    if (liftsMoving && document.visibilityState === 'visible') dirty = true;
    if (warm) dirty = true;
    // Guidage : caméra et repère glissent vers la dernière position, image après image.
    if (stepFollow(dt, now)) dirty = true;
    if (stepLabels(dt)) dirty = true;
    if (gestures.step(dt)) dirty = true;
    const animating = anim !== null;
    stepAnim(now);
    const moved = !animating && controls.update();
    if (!moved && !dirty && !animating) {
      lastFrame = 0;
      return;
    }
    if (moved) {
      constrainView();
      viewMovedAt = now;
    }
    dirty = false;
    treesDrawn = forest.update(camera, 1);
    syncModels();
    const streetsShown = camera.position.distanceTo(controls.target) < STREETS_MAX_M;
    for (const s of roads.streets) s.visible = streetsShown;
    liftsMoving = models.visible && vehiclesShown && vehicles.update(now / 1000, modelK, closedLifts, camera) > 0;
    vehicles.mesh.visible = models.visible && vehiclesShown && vehicles.mesh.count > 0;
    cullLabels();
    syncSun();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    for (const cb of frameCallbacks) cb();
    if (warm) stepWarm(now);

    if (lastFrame && now - lastFrame < 250) frameTimes.push(now - lastFrame);
    lastFrame = now;
    if (now - lastStats > 500) {
      lastStats = now;
      const recent = frameTimes.splice(0);
      const fps = recent.length ? 1000 / (recent.reduce((a, b) => a + b, 0) / recent.length) : 0;
      const info = renderer.info.render as { triangles?: number; drawCalls?: number; calls?: number };
      onStats({
        backend,
        fps: Math.round(fps),
        slowShare: recent.length ? recent.filter((d) => d > 26).length / recent.length : 0,
        trees: treesDrawn,
        triangles: info.triangles ?? 0,
        drawCalls: info.drawCalls ?? info.calls ?? 0,
      });
    }
  };
  // Programmes de dessin préparés d'avance (sinon, à-coups au premier passage de chaque objet) :
  // tout est montré le temps de les compiler, la boucle remet ensuite chaque chose à sa place.
  await step("Préparation de l'affichage", 0.57);
  models.visible = villages.visible = true;
  // (liftMesh est posé par buildModels : TypeScript ne le voit pas.)
  const lifts3d = liftMesh as THREE.Mesh | null;
  if (lifts3d) lifts3d.visible = true;
  placeMeshes.forEach((m) => (m.visible = true));
  try {
    await renderer.compileAsync(scene, camera);
  } catch {
    // Compilation d'avance impossible : elle se fera au premier dessin, sous l'écran de chargement.
  }
  placeMeshes.forEach((m, cat) => (m.visible = placeCategories.has(cat)));
  renderer.setAnimationLoop(loop);
  controls.addEventListener('change', () => (dirty = true));

  const resize = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    controls.maxDistance = MAX_DISTANCE * aspectFactor(camera.aspect);
    // Fenêtre élargie : la vue revient dans la nouvelle limite.
    if (camera.position.distanceTo(controls.target) > controls.maxDistance) {
      const v = currentView();
      placeCamera(v.x, v.z, controls.maxDistance, v.pitch, v.bearing);
    }
    dirty = true;
  });
  resize.observe(container);

  // ---- Photos aériennes, du centre vers l'extérieur ------------------------------------------
  // Celles du domaine d'abord : la carte n'est montrée qu'une fois toutes posées (ou au bout de
  // PHOTOS_MAX_MS, réseau lent), puis après quelques images régulières (warmUp).
  const PHOTOS_MAX_MS = 20_000;
  let detailPhotos = 0;
  let photosReady: () => void = () => undefined;
  const photosDone = new Promise<void>((resolve) => (photosReady = resolve));
  if (!detailChunks.length) photosReady();
  onProgress('Photos aériennes', 0.6);
  const queue = [...chunks].sort((a, b) => {
    const level = (c: Chunk) => (c.spec.z === 13 ? 0 : 1);
    return level(a) - level(b) || a.center.lengthSq() - b.center.lengthSq();
  });
  const PHOTO_JOBS = 4;
  void Promise.all(
    Array.from({ length: PHOTO_JOBS }, async () => {
      while (queue.length && !abort.signal.aborted) {
        const chunk = queue.shift()!;
        await chunk.loadPhoto(abort.signal);
        dirty = true;
        if (chunk.spec.z === 13 && ++detailPhotos <= detailChunks.length) {
          onProgress('Photos aériennes', 0.6 + (0.32 * detailPhotos) / detailChunks.length);
          if (detailPhotos === detailChunks.length) photosReady();
        }
      }
    }),
  );
  void Promise.race([photosDone, new Promise((resolve) => setTimeout(resolve, PHOTOS_MAX_MS))])
    .then(() => (abort.signal.aborted ? undefined : warmUp()))
    .then(() => !abort.signal.aborted && onProgress(null, 1));

  const v = new THREE.Vector3();
  return {
    setWinter(on) {
      winter.value = on ? 1 : 0;
      dirty = true;
    },
    setRotate(on) {
      controls.autoRotate = on;
      dirty = true;
    },
    flyTo,
    follow(target) {
      if (!target) {
        follow = null;
        return;
      }
      const [x, z] = frame.toXZ(target.lng, target.lat);
      anim = null;
      follow = { x, z, bearing: target.bearing ?? null };
      dirty = true;
    },
    overview() {
      flyTo({ lng: lng0, lat: lat0, distance: overviewDistance(), pitch: OVERVIEW_PITCH, bearing: domain.overviewBearing });
    },
    project(lng, lat, lift = 0) {
      const [x, z] = frame.toXZ(lng, lat);
      v.set(x, ground(x, z) + lift, z).project(camera);
      if (v.z > 1) return null;
      return { x: ((v.x + 1) / 2) * container.clientWidth, y: ((1 - v.y) / 2) * container.clientHeight };
    },
    addLabel,
    setClosedTracks(p, l) {
      tracks.setClosed(p, l);
      closedLifts = l;
      dirty = true;
    },
    setHighlight(list) {
      tracks.setHighlight(list);
      dirty = true;
    },
    setPlaceCategories(categories) {
      placeCategories = categories;
      placeMeshes.forEach((m, cat) => (m.visible = categories.has(cat)));
      // Snowparks : zones peintes, noms et modules suivent la même case.
      const parks = categories.has('snowpark');
      parksShown.value = parks ? 1 : 0;
      parkMesh.visible = parks;
      parkLabels.forEach((l) => l.setVisible(parks));
      dirty = true;
    },
    setRoute(steps, guiding) {
      route.set(steps, guiding);
      tracks.setFaded(!!steps && guiding);
      dirty = true;
    },
    elevation(lng, lat) {
      const [x, z] = frame.toXZ(lng, lat);
      return elev.at(x, z);
    },
    onPick(cb) {
      pickCallbacks.push(cb);
    },
    onFrame(cb) {
      frameCallbacks.add(cb);
      return () => frameCallbacks.delete(cb);
    },
    dispose() {
      abort.abort();
      clearTimeout(scaleTimer);
      renderer.setAnimationLoop(null);
      resize.disconnect();
      controls.dispose();
      gestures.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMovePick);
      renderer.domElement.removeEventListener('pointerup', onUp);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
    },
  };
}
