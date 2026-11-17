// Gestes tactiles de la carte Three.js, comme Google Maps ou Plans d'Apple :
// - un doigt : la carte suit le doigt (le point touché reste sous le doigt), et glisse sur sa
//   lancée au lâcher ;
// - deux doigts : pincer pour zoomer, tourner pour pivoter, en même temps, autour du point entre
//   les doigts (qui reste sous eux : on peut aussi déplacer la carte à deux doigts) ;
// - deux doigts glissés ensemble vers le haut ou le bas : inclinaison ;
// - double toucher : zoom avant sur ce point ; toucher à deux doigts : zoom arrière ;
// - toucher simple : sélection (piste, lieu…).
//
// Les événements tactiles sont pris avant MapControls (qui reste pour la souris et le trackpad).

import * as THREE from 'three/webgpu';

export interface View {
  x: number;
  z: number;
  distance: number;
  pitch: number;
  bearing: number;
}

export interface GestureApi {
  element: HTMLElement;
  camera: THREE.Camera;
  view(): View;
  /** Place la vue (bornée par la scène) et demande une image. */
  setView(v: View): void;
  /** Déplacement animé court (double toucher). */
  animateTo(v: View): void;
  /** Altitude du point visé (plan des gestes). */
  targetY(): number;
  /** Un geste commence : déplacement animé interrompu, suivi GPS suspendu. */
  onStart(): void;
  onTap(clientX: number, clientY: number): void;
  minDistance: number;
  maxDistance: number;
  maxPitch: number;
}

/** Au-delà, ce n'est plus un toucher mais un glissé (px) ; double toucher : délai (ms) et écart (px). */
const TAP_MOVE_PX = 8;
const TAP_MS = 350;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 40;
/** Seuils de reconnaissance à deux doigts : inclinaison, pivot (degrés), pincement (rapport). */
const TILT_START_PX = 10;
const ROTATE_START_DEG = 10;
const PINCH_START = 0.05;
/** Inclinaison : degrés par pixel de glissé vertical. */
const TILT_DEG_PER_PX = 0.3;
/** Glissé sur la lancée : temps de freinage (s). */
const FLING_DECAY_S = 0.32;

interface Pointer {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export function installTouchGestures(api: GestureApi): { step(dt: number): boolean; dispose(): void } {
  const el = api.element;
  const pointers = new Map<number, Pointer>();
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  /** Point du sol (plan à l'altitude du point visé) sous un point de l'écran, ou null (ciel). */
  const groundAt = (cx: number, cy: number): THREE.Vector3 | null => {
    const rect = el.getBoundingClientRect();
    api.camera.updateMatrixWorld();
    raycaster.setFromCamera(new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1), api.camera);
    plane.constant = -api.targetY();
    const p = raycaster.ray.intersectPlane(plane, hit);
    // Trop près de l'horizon : le point file à l'infini, on l'ignore.
    return p && p.distanceTo(api.camera.position) < 80_000 ? p.clone() : null;
  };

  // ---- Un doigt : déplacement, lancée ---------------------------------------------------------
  let panAnchor: THREE.Vector3 | null = null;
  const velocity = new THREE.Vector2();
  let lastMove = 0;
  let fling = false;
  /**
   * Le geste en cours peut-il encore être un toucher (sélection) ? Non s'il a arrêté une lancée,
   * mis deux doigts, bougé de plus de quelques pixels (même en revenant au départ) ou duré trop.
   */
  let tapCandidate = false;
  let gestureStart = 0;

  // ---- Deux doigts ------------------------------------------------------------------------------
  let two: {
    d0: number;
    a0: number;
    my0: number;
    view0: View;
    anchor: THREE.Vector3 | null;
    mode: 'none' | 'tilt' | 'zoomRotate';
    rotating: boolean;
    start: number;
    moved: boolean;
  } | null = null;

  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { a, b, d: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const startTwo = () => {
    const p = pair();
    two = { d0: p.d, a0: p.angle, my0: p.my, view0: api.view(), anchor: groundAt(p.mx, p.my), mode: 'none', rotating: false, start: performance.now(), moved: false };
    panAnchor = null;
  };

  /** Recale la vue pour que `anchor` (sol) revienne sous le point d'écran (cx, cy). */
  const keepUnder = (anchor: THREE.Vector3, cx: number, cy: number) => {
    const p = groundAt(cx, cy);
    if (!p) return;
    const v = api.view();
    api.setView({ ...v, x: v.x + (anchor.x - p.x), z: v.z + (anchor.z - p.z) });
  };

  let lastTap = { t: 0, x: 0, y: 0 };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    try {
      // Le doigt reste suivi même s'il sort du canevas (sur une pastille, le panneau…).
      el.setPointerCapture(e.pointerId);
    } catch {
      // Pointeur inconnu du navigateur (événement simulé) : suivi sans capture.
    }
    pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (pointers.size === 1) {
      // Toucher pendant que la carte glisse encore : il l'arrête, sans rien ouvrir.
      tapCandidate = !fling;
      gestureStart = performance.now();
    } else tapCandidate = false;
    fling = false;
    api.onStart();
    if (pointers.size === 1) {
      panAnchor = groundAt(e.clientX, e.clientY);
      velocity.set(0, 0);
      lastMove = performance.now();
    } else if (pointers.size === 2) startTwo();
  };

  const onMove = (e: PointerEvent) => {
    const ptr = pointers.get(e.pointerId);
    if (!ptr) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    if (Math.hypot(ptr.x - ptr.x0, ptr.y - ptr.y0) >= TAP_MOVE_PX) tapCandidate = false;

    if (pointers.size === 1 && panAnchor) {
      const before = api.view();
      keepUnder(panAnchor, ptr.x, ptr.y);
      const after = api.view();
      const now = performance.now();
      const dt = (now - lastMove) / 1000;
      // Vitesse lissée (m/s), pour la lancée au lâcher ; plafonnée selon l'altitude de vue (deux
      // événements trop rapprochés donnaient une vitesse absurde et une lancée à l'autre bout).
      if (dt >= 0.008) {
        velocity.lerp(new THREE.Vector2((after.x - before.x) / dt, (after.z - before.z) / dt), 0.5);
        const max = after.distance * 2.5;
        if (velocity.length() > max) velocity.setLength(max);
        lastMove = now;
      }
      return;
    }

    if (pointers.size === 2 && two) {
      const p = pair();
      const scale = p.d / two.d0;
      const da = wrapDeg(((p.angle - two.a0) * 180) / Math.PI);
      const dy = p.my - two.my0;
      if (Math.abs(scale - 1) > 0.02 || Math.abs(da) > 2 || Math.abs(dy) > 4) two.moved = true;
      if (two.mode === 'none') {
        // Les deux doigts glissent dans le même sens vertical, sans pincer ni tourner : inclinaison.
        const sameWay = Math.sign(p.a.y - p.a.y0) === Math.sign(p.b.y - p.b.y0);
        if (Math.abs(dy) > TILT_START_PX && sameWay && Math.abs(scale - 1) < PINCH_START && Math.abs(da) < ROTATE_START_DEG / 2) two.mode = 'tilt';
        else if (Math.abs(scale - 1) > PINCH_START || Math.abs(da) > ROTATE_START_DEG) two.mode = 'zoomRotate';
        else return;
        // Le geste part de la position actuelle.
        two.d0 = p.d;
        two.a0 = p.angle;
        two.my0 = p.my;
        two.view0 = api.view();
        two.anchor = groundAt(p.mx, p.my);
        return;
      }
      if (two.mode === 'tilt') {
        api.setView({ ...two.view0, pitch: clamp(two.view0.pitch - dy * TILT_DEG_PER_PX, 0, api.maxPitch) });
        return;
      }
      // Pincer et tourner, autour du point entre les doigts. Le pivot ne démarre qu'au-delà d'un
      // petit angle (on peut pincer sans tourner la carte).
      if (!two.rotating && Math.abs(da) > ROTATE_START_DEG) {
        two.rotating = true;
        two.a0 = p.angle;
        two.view0 = { ...two.view0, bearing: api.view().bearing };
      }
      const rot = two.rotating ? wrapDeg(((p.angle - two.a0) * 180) / Math.PI) : 0;
      const v = api.view();
      api.setView({
        ...v,
        distance: clamp(two.view0.distance / scale, api.minDistance, api.maxDistance),
        bearing: two.view0.bearing - rot,
      });
      if (two.anchor) keepUnder(two.anchor, p.mx, p.my);
    }
  };

  const onUp = (e: PointerEvent) => {
    const ptr = pointers.get(e.pointerId);
    if (!ptr) return;
    e.stopImmediatePropagation();
    pointers.delete(e.pointerId);
    const now = performance.now();

    if (two) {
      // Toucher à deux doigts, sans bouger : zoom arrière.
      if (!two.moved && now - two.start < TAP_MS && pointers.size === 1) {
        const v = api.view();
        api.animateTo({ ...v, distance: clamp(v.distance * 2, api.minDistance, api.maxDistance) });
      }
      two = null;
      // Le doigt restant reprend le déplacement.
      const rest = [...pointers.values()][0];
      if (rest) {
        rest.x0 = rest.x;
        rest.y0 = rest.y;
        panAnchor = groundAt(rest.x, rest.y);
        velocity.set(0, 0);
      }
      return;
    }

    if (pointers.size === 0) {
      const moved = Math.hypot(ptr.x - ptr.x0, ptr.y - ptr.y0);
      const tap = tapCandidate && moved < TAP_MOVE_PX && now - gestureStart < TAP_MS;
      tapCandidate = false;
      if (tap) {
        // Double toucher : zoom avant, centré sur le point touché.
        if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(ptr.x - lastTap.x, ptr.y - lastTap.y) < DOUBLE_TAP_PX) {
          const g = groundAt(ptr.x, ptr.y);
          const v = api.view();
          if (g) api.animateTo({ ...v, x: v.x + (g.x - v.x) / 2, z: v.z + (g.z - v.z) / 2, distance: clamp(v.distance / 2, api.minDistance, api.maxDistance) });
          lastTap = { t: 0, x: 0, y: 0 };
          return;
        }
        lastTap = { t: now, x: ptr.x, y: ptr.y };
        api.onTap(ptr.x, ptr.y);
        return;
      }
      // Lancée, si le doigt bougeait encore au lâcher.
      fling = now - lastMove < 80 && velocity.length() > 20;
      panAnchor = null;
    }
  };

  el.addEventListener('pointerdown', onDown, { capture: true });
  el.addEventListener('pointermove', onMove, { capture: true });
  el.addEventListener('pointerup', onUp, { capture: true });
  el.addEventListener('pointercancel', onUp, { capture: true });

  return {
    /** Lancée en cours ; vrai tant qu'il reste du mouvement (image à redessiner). */
    step(dt) {
      if (!fling) return false;
      const v = api.view();
      api.setView({ ...v, x: v.x + velocity.x * dt, z: v.z + velocity.y * dt });
      velocity.multiplyScalar(Math.exp(-dt / FLING_DECAY_S));
      if (velocity.length() < 5) fling = false;
      return true;
    },
    dispose() {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove, { capture: true });
      el.removeEventListener('pointerup', onUp, { capture: true });
      el.removeEventListener('pointercancel', onUp, { capture: true });
    },
  };
}
