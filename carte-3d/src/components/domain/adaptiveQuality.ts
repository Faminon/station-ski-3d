// Qualité adaptative de la carte 3D : si l'appareil n'arrive pas à suivre
// pendant les déplacements, la carte s'allège d'elle-même, palier par palier,
// comme le font les jeux vidéo.
//
// Mesure : durée des images pendant que la carte bouge (au repos, MapLibre ne
// redessine rien, il n'y a rien à mesurer). On regarde la durée médiane, qui
// ignore les à-coups isolés (tuiles qui arrivent) et ne réagit qu'à une
// lenteur durable : deux fenêtres lentes de suite, une fois la carte chargée.
// Les paliers ne font que descendre pendant une visite (pas de va-et-vient
// visible) ; le palier atteint est retenu sur l'appareil, et la visite
// suivante repart un cran au-dessus pour retenter sa chance.
//
// `?qualite=0` à `?qualite=3` dans l'adresse impose un palier (tests).

import type { Map as MlMap } from 'maplibre-gl';

export interface QualityLevel {
  /** Plafond de la résolution de rendu (multiplié par la densité de l'écran, sans la dépasser). */
  maxPixelRatio: number;
  /** Part des sapins 3D dessinés. */
  treeDensity: number;
  label: string;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { maxPixelRatio: 2, treeDensity: 1, label: 'maximale' },
  { maxPixelRatio: 1.5, treeDensity: 0.6, label: 'haute' },
  { maxPixelRatio: 1, treeDensity: 0.35, label: 'moyenne' },
  { maxPixelRatio: 1, treeDensity: 0, label: 'économe' },
];

/**
 * Durée médiane d'image au-delà de laquelle on allège (ms) : sous ~42 images par seconde. Les
 * images s'affichent par paliers de l'écran : 20,7 ms à 144 Hz (≈48 images par seconde) ne
 * déclenche rien, alors qu'un écran 60 Hz tombé à 30 images par seconde (33 ms) allège.
 */
const SLOW_MEDIAN_MS = 24;
/** Images mesurées en mouvement avant de juger (environ 1,5 s à 60 Hz). */
const SAMPLE = 90;
/** Fenêtres lentes consécutives nécessaires pour alléger d'un palier. */
const SLOW_WINDOWS = 2;
/** Délai sans jugement après le premier affichage complet et après chaque allègement (ms). */
const SETTLE_MS = 2000;
/** Écarts entre images ignorés au-delà (onglet en arrière-plan, pause du navigateur). */
const MAX_DELTA_MS = 250;
const STORAGE_KEY = 'carte3d-qualite';

export interface QualityTargets {
  /** Applique la densité des sapins 3D (0 à 1). */
  setTreeDensity(density: number): void;
}

export interface QualityController {
  readonly level: number;
  /** Jugements rendus (instant, durée médiane, palier ensuite), pour le banc d'essai. */
  readonly history: { at: number; median: number; level: number }[];
  /** Les sapins sont arrivés après coup : on leur applique le palier courant. */
  refresh(): void;
  stop(): void;
}

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 && n < QUALITY_LEVELS.length ? n : null;
  } catch {
    return null;
  }
}

function store(level: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(level));
  } catch {
    // Stockage indisponible (navigation privée…) : on repartira du palier maximal.
  }
}

export function installAdaptiveQuality(map: MlMap, targets: QualityTargets): QualityController {
  const forced = Number(new URLSearchParams(window.location.search).get('qualite'));
  const isForced = new URLSearchParams(window.location.search).has('qualite') && Number.isInteger(forced) && forced >= 0 && forced < QUALITY_LEVELS.length;
  const stored = readStored();
  let level = isForced ? forced : stored === null ? 0 : Math.max(0, stored - 1);
  // Retenu tout de suite : sans nouvel allègement, chaque visite remonte d'un cran jusqu'au maximum.
  if (!isForced && stored !== null) store(level);

  const apply = () => {
    const q = QUALITY_LEVELS[level];
    const ratio = Math.min(window.devicePixelRatio || 1, q.maxPixelRatio);
    if (Math.abs(map.getPixelRatio() - ratio) > 0.01) map.setPixelRatio(ratio);
    targets.setTreeDensity(q.treeDensity);
  };
  apply();

  const history: QualityController['history'] = [];
  const deltas: number[] = [];
  let raf = 0;
  let last = 0;
  // Pas de jugement pendant le chargement (tuiles, relief, données : toutes les images sont
  // lentes, même sur une machine puissante) ni juste après un allègement (la carte se recompose).
  let judgeAfter = Infinity;
  let slowStreak = 0;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  map.once('idle', () => {
    readyTimer = setTimeout(() => (judgeAfter = performance.now()), SETTLE_MS);
  });

  const sample = (now: number) => {
    if (last && now >= judgeAfter && !document.hidden) {
      const dt = now - last;
      if (dt < MAX_DELTA_MS) deltas.push(dt);
    }
    last = now;
    if (deltas.length >= SAMPLE) judge(now);
    raf = requestAnimationFrame(sample);
  };
  const judge = (now: number) => {
    const sorted = [...deltas].sort((a, b) => a - b);
    deltas.length = 0;
    const median = sorted[Math.floor(sorted.length / 2)];
    slowStreak = median > SLOW_MEDIAN_MS ? slowStreak + 1 : 0;
    // Deux fenêtres lentes d'affilée (environ 3 s de mouvement) : une lenteur passagère ne suffit pas.
    if (slowStreak >= SLOW_WINDOWS && level < QUALITY_LEVELS.length - 1) {
      level++;
      slowStreak = 0;
      judgeAfter = now + SETTLE_MS;
      store(level);
      apply();
    }
    history.push({ at: Math.round(now), median: Math.round(median * 10) / 10, level });
    if (history.length > 50) history.shift();
  };
  const start = () => {
    if (raf || isForced) return;
    last = 0;
    raf = requestAnimationFrame(sample);
  };
  const pause = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  map.on('movestart', start);
  map.on('moveend', pause);

  return {
    get level() {
      return level;
    },
    history,
    refresh: apply,
    stop() {
      pause();
      clearTimeout(readyTimer);
      map.off('movestart', start);
      map.off('moveend', pause);
    },
  };
}
