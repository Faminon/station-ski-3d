// Mesure de la fluidité de la carte, réservée aux tests : rien n'est chargé
// sans `?fps` ou `?bench` dans l'adresse.
//
// - `?fps`   : compteur d'images par seconde et pire image de la dernière demi-seconde.
// - `?bench` : parcours de caméra toujours identique (survol, forêt, rotation,
//              déplacement, recul), joué une fois pour charger les tuiles puis
//              une seconde fois en mesurant. Résultat affiché et renvoyé par
//              `window.__carteBench()` (relançable depuis la console).

import type { LngLatLike, Map as MlMap } from 'maplibre-gl';
import type { QualityController } from './adaptiveQuality';

export interface BenchResult {
  /** Images par seconde en moyenne sur le parcours mesuré. */
  fps: number;
  /** Durée d'image (ms) : médiane, 95e et 99e centiles, pire. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Part des images plus longues que 20 ms (sous 50 fps : saccade visible). */
  slowPct: number;
  /** Images de plus de 50 ms (à-coup franc). */
  hitches: number;
  /** Temps cumulé des tâches longues du fil principal (ms), si le navigateur le mesure. */
  blockingMs: number | null;
  frames: number;
  durationMs: number;
  pixelRatio: number;
  canvas: string;
  /** Palier de qualité adaptative à la fin du parcours (0 = maximal). */
  quality: number | null;
}

declare global {
  interface Window {
    __carteBench?: () => Promise<BenchResult>;
    /** La carte elle-même, pour couper un calque depuis la console et mesurer son coût. */
    __carteMap?: MlMap;
    /** Qualité adaptative : palier courant et jugements rendus. */
    __carteQuality?: Pick<QualityController, 'level' | 'history'>;
  }
}

function overlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;padding:6px 9px;border-radius:8px;background:rgba(10,20,30,.82);color:#fff;font:12px/1.35 ui-monospace,monospace;white-space:pre;pointer-events:none';
  document.body.append(el);
  return el;
}

/** Compteur permanent : images par seconde et pire image, rafraîchi deux fois par seconde. */
function startFpsMeter(el: HTMLDivElement, quality?: Pick<QualityController, 'level'>): () => void {
  let raf = 0;
  let last = performance.now();
  let windowStart = last;
  let frames = 0;
  let worst = 0;
  const tick = (now: number) => {
    const dt = now - last;
    last = now;
    frames++;
    worst = Math.max(worst, dt);
    if (now - windowStart >= 500) {
      const fps = (frames * 1000) / (now - windowStart);
      el.dataset.fps = `${Math.round(fps)} fps · pire ${Math.round(worst)} ms${quality ? ` · qualité ${quality.level}` : ''}`;
      el.textContent = [el.dataset.fps, el.dataset.bench].filter(Boolean).join('\n');
      frames = 0;
      worst = 0;
      windowStart = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
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

async function runBench(map: MlMap, center: LngLatLike, forest: [number, number], el: HTMLDivElement, quality?: Pick<QualityController, 'level'>): Promise<BenchResult> {
  el.dataset.bench = 'banc : chargement des tuiles…';
  // Premier passage : remplit les caches (tuiles, relief), non mesuré.
  await scenario(map, center, forest);
  await wait(map, 'idle');
  el.dataset.bench = 'banc : mesure en cours…';

  const deltas: number[] = [];
  let measuring = true;
  let last = performance.now();
  const start = last;
  const tick = (now: number) => {
    deltas.push(now - last);
    last = now;
    if (measuring) requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    last = now;
    requestAnimationFrame(tick);
  });

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
  measuring = false;
  observer?.disconnect();
  const durationMs = performance.now() - start;

  const sorted = [...deltas].sort((a, b) => a - b);
  const canvas = map.getCanvas();
  const result: BenchResult = {
    fps: round1((deltas.length * 1000) / durationMs),
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    p99: round1(percentile(sorted, 99)),
    max: round1(sorted[sorted.length - 1] ?? 0),
    slowPct: round1((100 * deltas.filter((d) => d > 20).length) / Math.max(1, deltas.length)),
    hitches: deltas.filter((d) => d > 50).length,
    blockingMs: blocking === null ? null : Math.round(blocking),
    frames: deltas.length,
    durationMs: Math.round(durationMs),
    pixelRatio: map.getPixelRatio(),
    canvas: `${canvas.width}×${canvas.height}`,
    quality: quality ? quality.level : null,
  };
  el.dataset.bench =
    `banc : ${result.fps} fps moy. · p95 ${result.p95} ms · pire ${result.max} ms\n` +
    `       ${result.slowPct} % > 20 ms · ${result.hitches} à-coups > 50 ms · blocage ${result.blockingMs ?? '?'} ms\n` +
    `       rendu ${result.canvas} (×${result.pixelRatio}) · qualité ${result.quality ?? '?'}`;
  console.info('[carte-bench]', result);
  return result;
}

/**
 * Installe le compteur et le banc d'essai si l'adresse le demande.
 * `forest` : point d'arrivée du parcours, au cœur d'une grande forêt du domaine ;
 * `quality` : palier de qualité adaptative courant, affiché avec les mesures.
 */
export function installPerfProbe(map: MlMap, center: LngLatLike, forest: [number, number], quality?: Pick<QualityController, 'level' | 'history'>): () => void {
  if (typeof window === 'undefined') return () => {};
  const params = new URLSearchParams(window.location.search);
  if (!params.has('fps') && !params.has('bench')) return () => {};
  const el = overlay();
  const stopMeter = startFpsMeter(el, quality);
  let running: Promise<BenchResult> | null = null;
  window.__carteBench = () => (running ??= runBench(map, center, forest, el, quality).finally(() => (running = null)));
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
