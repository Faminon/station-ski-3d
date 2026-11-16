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
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { domainDetailBounds } from '@/lib/domainArea';
import type { SkiDomainConfig } from '@/lib/skiDomains';
import type { DomainData, TrackLine } from './domainData';
import { loadElevation } from './elevation';
import { buildForest, type Forest } from './forest';
import { EXAGGERATION, makeFrame, tilesCovering } from './geo';
import { buildPeakLabels, buildRouteLayer, buildTrackLayer, type RouteStepLine } from './overlays';
import { buildChunk, winter, type Chunk } from './terrain';

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
  /** Étiquette HTML posée sur le relief ; masquée au-delà de `maxDistance` (m) de la caméra. */
  addLabel(el: HTMLElement, lng: number, lat: number, options?: { lift?: number; maxDistance?: number; anchorBottom?: boolean }): LabelHandle;
  setClosedTracks(pistes: Set<number>, lifts: Set<number>): void;
  setHighlight(tracks: TrackLine[] | null): void;
  /** Itinéraire affiché (ou rien) ; en guidage, le reste du domaine est grisé. */
  setRoute(steps: RouteStepLine[] | null, guiding: boolean): void;
  /** Altitude réelle (m) d'un point, null hors des tuiles chargées (réseau des itinéraires). */
  elevation(lng: number, lat: number): number | null;
  /** Clic (ou toucher) sur le relief, sans glisser. */
  onPick(callback: (e: PickEvent) => void): void;
  /** Appelé après chaque image dessinée (bulles qui suivent la carte). */
  onFrame(callback: () => void): () => void;
  dispose(): void;
}

const SKY = '#cfe6f8';
const FOG = '#e4f1fb';
/** Cadre autour du centre : même étendue que la carte MapLibre (maxBounds), un peu réduite. */
const WIDE_LNG = 0.5;
const WIDE_LAT = 0.35;
/** Altitude minimale de la caméra au-dessus du sol (m). */
const CAMERA_CLEARANCE = 80;
const OVERVIEW_DISTANCE = 19_000;
const OVERVIEW_PITCH = 52;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function createScene(
  container: HTMLElement,
  domain: SkiDomainConfig,
  data: DomainData,
  options: SceneOptions,
  onProgress: (label: string) => void,
  onStats: (stats: SceneStats) => void,
): Promise<SceneHandle> {
  const abort = new AbortController();
  const [lng0, lat0] = domain.center;
  const frame = makeFrame(lng0, lat0);
  const { pistes, forests } = data;

  const detailBounds = domainDetailBounds(pistes, 2);
  const wideBounds: [number, number, number, number] = [lng0 - WIDE_LNG, lat0 - WIDE_LAT, lng0 + WIDE_LNG, lat0 + WIDE_LAT];
  const detailTiles = tilesCovering(detailBounds, 13);
  const farTiles = tilesCovering(wideBounds, 11);

  onProgress('Relief');
  const elev = await loadElevation(frame, [
    { zoom: 14, tiles: tilesCovering(detailBounds, 14) },
    { zoom: 11, tiles: farTiles },
  ]);
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
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(FOG, 22_000, 70_000);

  // Lumière rasante du nord-ouest, comme l'ombrage des cartes : versants bien modelés. Le ciel
  // bleuté éclaire les versants à l'ombre (intensités « physiques » : × π pour un blanc franc).
  const sun = new THREE.DirectionalLight('#fff6ea', 1.0 * Math.PI);
  sun.position.set(-1, 0.75, -0.8);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#c3d6f5', '#5d6f91', 0.3 * Math.PI));

  // ---- Relief ------------------------------------------------------------------------------
  onProgress('Maillage du relief');
  const forestPolygons: number[][][][] = [];
  for (const f of forests.features) {
    if (f.geometry.type === 'Polygon') forestPolygons.push(f.geometry.coordinates);
    else if (f.geometry.type === 'MultiPolygon') forestPolygons.push(...f.geometry.coordinates);
  }
  const maxAnisotropy = renderer.getMaxAnisotropy();
  const chunks: Chunk[] = [];
  for (const [x, y] of detailTiles) {
    chunks.push(buildChunk(frame, elev, { z: 13, x, y, segments: options.segments, textureZoom: 15, drop: 0 }, maxAnisotropy, forestPolygons));
  }
  const detailChunks = [...chunks];
  for (const [x, y] of farTiles) {
    chunks.push(buildChunk(frame, elev, { z: 11, x, y, segments: 64, textureZoom: 12, drop: 12 }, maxAnisotropy, forestPolygons));
  }
  for (const c of chunks) {
    c.mesh.updateMatrix();
    scene.add(c.mesh);
  }
  const pickable = chunks.map((c) => c.mesh);

  // ---- Tracés, sommets, sapins ---------------------------------------------------------------
  onProgress('Pistes et remontées');
  const tracks = buildTrackLayer(frame, elev, data.tracks);
  scene.add(tracks.group);
  const route = buildRouteLayer(frame, elev);
  scene.add(route.group);
  scene.add(buildPeakLabels(frame, elev, pistes));

  onProgress('Sapins');
  const forest: Forest = buildForest(
    frame,
    elev,
    forests,
    [
      ...data.tracks.pistes.map((p) => ({ coordinates: p.coordinates, halfWidth: 16 })),
      ...data.tracks.lifts.map((l) => ({ coordinates: l.coordinates, halfWidth: 7 })),
    ],
    detailChunks,
  );
  scene.add(forest.group);

  // ---- Caméra ------------------------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 20, 90_000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false;
  controls.minDistance = 250;
  controls.maxDistance = 45_000;
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
  placeCamera(0, 0, OVERVIEW_DISTANCE, OVERVIEW_PITCH, domain.overviewBearing);
  controls.update();

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
  // Un geste de l'utilisateur interrompt le déplacement.
  controls.addEventListener('start', () => (anim = null));

  // ---- Étiquettes ------------------------------------------------------------------------------
  const labelGroup = new THREE.Group();
  scene.add(labelGroup);
  const limited = new Map<CSS2DObject, number>();
  const addLabel: SceneHandle['addLabel'] = (el, lng, lat, opts = {}) => {
    const obj = new CSS2DObject(el);
    const lift = opts.lift ?? 0;
    const place = (lo: number, la: number) => {
      const [x, z] = frame.toXZ(lo, la);
      obj.position.set(x, ground(x, z) + lift, z);
    };
    place(lng, lat);
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

  // ---- Sélection au clic ----------------------------------------------------------------------
  const pickCallbacks: ((e: PickEvent) => void)[] = [];
  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY, t: performance.now() });
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 500) return;
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickable, false)[0];
    if (!hit) return;
    const [lng, lat] = frame.toLngLat(hit.point.x, hit.point.z);
    for (const cb of pickCallbacks) cb({ lng, lat, distance: hit.distance });
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  // ---- Boucle de rendu ---------------------------------------------------------------------
  let dirty = true;
  const frameTimes: number[] = [];
  let lastFrame = 0;
  let lastStats = 0;
  let treesDrawn = 0;
  const frameCallbacks = new Set<() => void>();

  const keepAboveGround = () => {
    // Le point visé suit le relief (rotation autour du sol), la caméra ne passe jamais dessous.
    const dy = ground(controls.target.x, controls.target.z) - controls.target.y;
    controls.target.y += dy;
    camera.position.y += dy;
    const floor = ground(camera.position.x, camera.position.z) + CAMERA_CLEARANCE;
    if (camera.position.y < floor) camera.position.y = floor;
  };

  const loop = (now: number) => {
    const animating = anim !== null;
    stepAnim(now);
    const moved = !animating && controls.update();
    if (!moved && !dirty && !animating) {
      lastFrame = 0;
      return;
    }
    if (moved) keepAboveGround();
    dirty = false;
    treesDrawn = forest.update(camera, 1);
    cullLabels();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    for (const cb of frameCallbacks) cb();

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
    dirty = true;
  });
  resize.observe(container);

  // ---- Photos aériennes, du centre vers l'extérieur ------------------------------------------
  onProgress('');
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
      }
    }),
  );

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
    overview() {
      flyTo({ lng: lng0, lat: lat0, distance: OVERVIEW_DISTANCE, pitch: OVERVIEW_PITCH, bearing: domain.overviewBearing });
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
      dirty = true;
    },
    setHighlight(list) {
      tracks.setHighlight(list);
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
      renderer.setAnimationLoop(null);
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
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
