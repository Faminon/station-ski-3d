// Mesure de la fluidité de la carte, réservée aux tests : rien n'est chargé
// sans `?fps` ou `?bench` dans l'adresse.
//
// - `?fps`   : compteur des images réellement dessinées par la carte (au repos,
//              elle ne dessine rien) et pire image de la dernière demi-seconde.
// - `?bench` : parcours de caméra toujours identique (survol, forêt, rotation,
//              déplacement, recul), joué une fois pour charger les tuiles puis
//              une seconde fois en mesurant. Résultat affiché et renvoyé par
//              `window.__carteBench()` (relançable depuis la console).
//
// Les durées sont celles qui séparent deux images dessinées par la carte, pas
// les rafraîchissements de l'écran : avec le limiteur d'images (frameLimiter.ts),
// la carte dessine volontairement moins souvent que l'écran ne rafraîchit.

import type { LngLatLike, Map as MlMap } from 'maplibre-gl';
import { frameTime, type QualityController } from './adaptiveQuality';
import type { FrameLimiter } from './frameLimiter';

/** Sous 40 images par seconde : image de plus de 25 ms (2 ms de tolérance sur les instants d'affichage). */
const UNDER_40_MS = 27;

export interface BenchResult {
  /** Images par seconde en moyenne sur le parcours mesuré. */
  fps: number;
  /** Durée d'image (ms) : médiane, 95e et 99e centiles, pire. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Durée visée par le limiteur d'images (ms) et part des images en retard (voir FrameLimiter.lateMs). */
  targetMs: number;
  latePct: number;
  /** Part des images sous 40 images par seconde, et leur nombre. */
  under40Pct: number;
  under40: number;
  /** Images de plus de 50 ms (à-coup franc). */
  hitches: number;
  /** Temps cumulé des tâches longues du fil principal (ms), si le navigateur le mesure. */
  blockingMs: number | null;
  frames: number;
  durationMs: number;
  pixelRatio: number;
  canvas: string;
  /** Écran : fréquence mesurée (Hz) et rafraîchissements par image dessinée. */
  refreshHz: number;
  every: number;
  /** Palier de qualité adaptative à la fin du parcours (0 = maximal). */
  quality: number | null;
}

type Quality = Pick<QualityController, 'level' | 'history'>;
type Limiter = Pick<FrameLimiter, 'frameMs' | 'refreshHz' | 'every' | 'lateMs'>;

declare global {
  interface Window {
    __carteBench?: () => Promise<BenchResult>;
    /** La carte elle-même, pour couper un calque depuis la console et mesurer son coût. */
    __carteMap?: MlMap;
    /** Qualité adaptative : palier courant et jugements rendus. */
    __carteQuality?: Quality;
  }
}

function overlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;padding:6px 9px;border-radius:8px;background:rgba(10,20,30,.82);color:#fff;font:12px/1.35 ui-monospace,monospace;white-space:pre;pointer-events:none';
  document.body.append(el);
  return el;
}

/** Compteur permanent des images dessinées par la carte, rafraîchi deux fois par seconde. */
function startFpsMeter(map: MlMap, el: HTMLDivElement, quality: Quality, limiter: Limiter): () => void {
  let last = 0;
  let frames = 0;
  let worst = 0;
  const onRender = () => {
    const now = frameTime();
    // Reprise après un repos : l'attente n'est pas une image lente.
    if (last && now - last < 250) worst = Math.max(worst, now - last);
    last = now;
    frames++;
  };
  map.on('render', onRender);
  const timer = setInterval(() => {
    const cap = limiter.every > 1 ? ` · plafond ${Math.round(1000 / limiter.frameMs)}` : '';
    el.dataset.fps = `${frames ? `${frames * 2} fps · pire ${Math.round(worst)} ms` : 'au repos'}${cap} · écran ${limiter.refreshHz} Hz · qualité ${quality.level}`;
    el.textContent = [el.dataset.fps, el.dataset.bench].filter(Boolean).join('\n');
    frames = 0;
    worst = 0;
  }, 500);
  return () => {
    clearInterval(timer);
    map.off('render', onRender);
  };
}

const wait = (map: MlMap, event: 'moveend' | 'idle') => new Promise<void>((resolve) => map.once(event, () => resolve()));

/** Parcours de caméra du banc d'essai (environ 20 s). */
async function scenario(map: MlMap, center: LngLatLike, forest: [number, number]) {
  map.jumpTo({ center, zoom: 11.5, pitch: 52, bearing: 180 });
  await wait(map, 'idle');
  // Plongée sur la plus grande forêt du domaine (sapins 3D, remontées).
  map.flyTo({ center: forest, zoom: 15, pitch: 65, bearing: 200, duration: 5000, essential: true });
  await wait(map, 'moveend');
  // Demi-tour autour du point de vue.
  map.easeTo({ bearing: 380, duration: 6000, easing: (t) => t, essential: true });
  await wait(map, 'moveend');
  // Glissement d'environ 1,5 km vers l'est.
  map.easeTo({ center: [forest[0] + 0.02, forest[1] + 0.004], duration: 4000, essential: true });
  await wait(map, 'moveend');
  // Recul vers la vue d'ensemble.
  map.easeTo({ zoom: 12.5, pitch: 60, duration: 4000, essential: true });
  await wait(map, 'moveend');
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const round1 = (x: number) => Math.round(x * 10) / 10;

async function runBench(map: MlMap, center: LngLatLike, forest: [number, number], el: HTMLDivElement, quality: Quality, limiter: Limiter): Promise<BenchResult> {
  el.dataset.bench = 'banc : chargement des tuiles…';
  // Premier passage : remplit les caches (tuiles, relief), non mesuré.
  await scenario(map, center, forest);
  await wait(map, 'idle');
  el.dataset.bench = 'banc : mesure en cours…';

  // Le parcours démarre par un saut puis une attente (carte au repos) : on ne mesure que les images en mouvement.
  const deltas: number[] = [];
  let last = 0;
  const onRender = () => {
    const now = frameTime();
    if (last && map.isMoving()) deltas.push(now - last);
    last = map.isMoving() ? now : 0;
  };
  map.on('render', onRender);

  let blocking: number | null = null;
  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    blocking = 0;
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) blocking! += Math.max(0, e.duration - 50);
    });
    observer.observe({ type: 'longtask', buffered: false });
  }

  await scenario(map, center, forest);
  map.off('render', onRender);
  observer?.disconnect();
  const durationMs = deltas.reduce((a, b) => a + b, 0);

  const sorted = [...deltas].sort((a, b) => a - b);
  const canvas = map.getCanvas();
  const targetMs = limiter.frameMs;
  const under40 = deltas.filter((d) => d > UNDER_40_MS).length;
  const result: BenchResult = {
    fps: round1((deltas.length * 1000) / Math.max(1, durationMs)),
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    p99: round1(percentile(sorted, 99)),
    max: round1(sorted[sorted.length - 1] ?? 0),
    targetMs: round1(targetMs),
    latePct: round1((100 * deltas.filter((d) => d > limiter.lateMs).length) / Math.max(1, deltas.length)),
    under40Pct: round1((100 * under40) / Math.max(1, deltas.length)),
    under40,
    hitches: deltas.filter((d) => d > 50).length,
    blockingMs: blocking === null ? null : Math.round(blocking),
    frames: deltas.length,
    durationMs: Math.round(durationMs),
    pixelRatio: map.getPixelRatio(),
    canvas: `${canvas.width}×${canvas.height}`,
    refreshHz: limiter.refreshHz,
    every: limiter.every,
    quality: quality.level,
  };
  el.dataset.bench =
    `banc : ${result.fps} fps moy. · médiane ${result.p50} ms · p99 ${result.p99} ms · pire ${result.max} ms\n` +
    `       sous 40 fps : ${result.under40} images (${result.under40Pct} %) · ${result.hitches} à-coups > 50 ms · blocage ${result.blockingMs ?? '?'} ms\n` +
    `       rendu ${result.canvas} (×${result.pixelRatio}) · qualité ${result.quality ?? '?'}`;
  console.info('[carte-bench]', result);
  return result;
}

/**
 * Installe le compteur et le banc d'essai si l'adresse le demande.
 * `forest` : point d'arrivée du parcours, au cœur d'une grande forêt du domaine.
 */
export function installPerfProbe(map: MlMap, center: LngLatLike, forest: [number, number], quality: Quality, limiter: Limiter): () => void {
  if (typeof window === 'undefined') return () => {};
  const params = new URLSearchParams(window.location.search);
  if (!params.has('fps') && !params.has('bench')) return () => {};
  const el = overlay();
  const stopMeter = startFpsMeter(map, el, quality, limiter);
  let running: Promise<BenchResult> | null = null;
  window.__carteBench = () => (running ??= runBench(map, center, forest, el, quality, limiter).finally(() => (running = null)));
  window.__carteMap = map;
  window.__carteQuality = quality;
  if (params.has('bench')) map.once('idle', () => void window.__carteBench?.());
  return () => {
    stopMeter();
    el.remove();
    delete window.__carteBench;
    delete window.__carteMap;
    delete window.__carteQuality;
  };
}
