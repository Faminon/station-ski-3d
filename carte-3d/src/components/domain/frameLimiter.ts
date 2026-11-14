// Cadence régulière de la carte 3D : plutôt que de dessiner aussi vite que
// possible (des images tantôt rapides, tantôt lentes, donc des à-coups
// visibles), la carte dessine une image tous les N rafraîchissements de
// l'écran, à un rythme proche de TARGET_FPS qu'elle tient avec de la marge.
//
// Un écran n'affiche qu'à ses propres instants : la cadence est donc un
// diviseur de sa fréquence, le plus proche au-dessus de la cible.
//   144 Hz → 1 image sur 3 = 48 images par seconde (40 tout rond donnerait des
//            images de durées inégales, donc des saccades) ;
//   120 Hz → 1 sur 3 = 40 ; 90 Hz → 1 sur 2 = 45 ; 60 Hz → toutes = 60
//            (1 sur 2 ferait 30, sous la cible).
//
// `?fpsmax=0` dans l'adresse retire le plafond, `?fpsmax=30` change la cible (tests).

import type { Map as MlMap } from 'maplibre-gl';

export const TARGET_FPS = 40;

const REFRESH_RATES = [50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240];

export interface FrameLimiter {
  /** Durée visée d'une image de la carte (ms) : N rafraîchissements de l'écran. */
  readonly frameMs: number;
  /** Fréquence de l'écran mesurée (Hz) et nombre de rafraîchissements par image dessinée. */
  readonly refreshHz: number;
  readonly every: number;
  /**
   * Durée au-delà de laquelle une image est en retard (ms) : la durée visée, mais jamais moins
   * que la cadence minimale (40 images par seconde, soit 25 ms), avec 4 % de tolérance sur les
   * instants d'affichage. Sert à la qualité adaptative et au banc d'essai.
   */
  readonly lateMs: number;
  stop(): void;
}

export function installFrameLimiter(map: MlMap): FrameLimiter {
  const param = new URLSearchParams(window.location.search).get('fpsmax');
  const target = param === null ? TARGET_FPS : Number(param);
  const enabled = Number.isFinite(target) && target > 0;
  // Cadence en dessous de laquelle la carte est jugée trop lente, plafond ou non.
  const minFps = enabled ? target : TARGET_FPS;

  let refreshHz = 60;
  let interval = 1000 / refreshHz;
  let every = 1;
  let stopped = false;

  // ---- Fréquence de l'écran : écart le plus courant entre deux rafraîchissements ----
  // Mesurée au départ, puis à nouveau une fois la carte chargée (le chargement fausse les écarts).
  let measuring = 0;
  const measure = () => {
    cancelAnimationFrame(measuring);
    const deltas: number[] = [];
    let last = 0;
    const tick = (now: number) => {
      if (stopped) return;
      if (last) deltas.push(now - last);
      last = now;
      if (deltas.length < 40) {
        measuring = requestAnimationFrame(tick);
        return;
      }
      // Quartile bas : les images retardées allongent les écarts, jamais l'inverse.
      deltas.sort((a, b) => a - b);
      const hz = 1000 / deltas[Math.floor(deltas.length / 4)];
      refreshHz = REFRESH_RATES.reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best));
      interval = 1000 / refreshHz;
      every = enabled ? Math.max(1, Math.floor(refreshHz / target + 0.05)) : 1;
    };
    measuring = requestAnimationFrame(tick);
  };
  measure();
  map.once('idle', measure);

  // ---- Plafond : la carte ne dessine qu'un rafraîchissement de l'écran sur `every`. ----
  // MapLibre demande ses images par `triggerRepaint`, puis dessine au rafraîchissement suivant.
  // On reprend la main sur cette boucle : les demandes sont notées, et c'est notre propre rappel
  // de rafraîchissement qui fait dessiner la carte, tout de suite, quand l'heure est venue. Une
  // image un peu longue ne décale donc pas la suivante (3 rafraîchissements, jamais 4 de ce fait).
  // Les animations de caméra de MapLibre suivent l'heure réelle : elles restent à la bonne vitesse.
  const repaint = map.triggerRepaint.bind(map);
  // Rendu immédiat (méthode interne de MapLibre, avec l'instant du rafraîchissement que ses gestes
  // utilisent) ; à défaut, `redraw()`, l'équivalent public sans cet instant.
  const internals = map as unknown as { _render?: (t: number) => void; _frameRequest?: AbortController | null; style?: unknown };
  const renderNow = (now: number) => {
    if (!internals.style) return;
    internals._frameRequest?.abort();
    internals._frameRequest = null;
    try {
      if (typeof internals._render === 'function') internals._render(now);
      else map.redraw();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
    }
  };
  let lastRender = -Infinity;
  let wanted = false;
  let raf = 0;
  const tick = (now: number) => {
    raf = 0;
    if (!wanted || stopped) return;
    // Demi-rafraîchissement de tolérance : les instants de rafraîchissement ne sont pas parfaitement réguliers.
    if (now - lastRender >= (every - 0.5) * interval) {
      wanted = false;
      lastRender = now;
      renderNow(now);
    } else {
      raf = requestAnimationFrame(tick);
    }
  };
  if (enabled) {
    map.triggerRepaint = () => {
      if (every <= 1 || stopped) return repaint();
      wanted = true;
      if (!raf) raf = requestAnimationFrame(tick);
    };
  }

  return {
    get frameMs() {
      return every * interval;
    },
    get refreshHz() {
      return refreshHz;
    },
    get every() {
      return every;
    },
    get lateMs() {
      return Math.max(every * interval, 1000 / minFps) * 1.04;
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(measuring);
      cancelAnimationFrame(raf);
    },
  };
}
