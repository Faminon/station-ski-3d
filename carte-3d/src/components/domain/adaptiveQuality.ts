// Qualité adaptative de la carte 3D : si l'appareil n'arrive pas à suivre
// pendant les déplacements, la carte s'allège d'elle-même, palier par palier,
// comme le font les jeux vidéo.
//
// Mesure : durée des images dessinées pendant que la carte bouge (au repos,
// MapLibre ne redessine rien), comparée à la cadence visée par le limiteur
// d'images et jamais sous 40 images par seconde (frameLimiter.ts, lateMs).
// On regarde le 90e centile : une fenêtre est lente quand plus d'une image sur
// dix est en retard (la médiane, elle, restait à l'heure alors qu'une image sur
// trois tombait à 36 par seconde, bien visible). Il faut deux fenêtres lentes
// de suite, une fois la carte chargée, pour alléger.
// Les paliers ne font que descendre pendant une visite (pas de va-et-vient
// visible) ; le palier atteint est retenu sur l'appareil, et la visite
// suivante repart un cran au-dessus pour retenter sa chance.
//
// `?qualite=0` à `?qualite=3` dans l'adresse impose un palier (tests).

import type { Map as MlMap } from 'maplibre-gl';
import type { FrameLimiter } from './frameLimiter';

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

/** Part des images qui doivent être à l'heure : au-delà d'une sur dix en retard, on allège. */
const SLOW_PERCENTILE = 0.9;
/** Images mesurées en mouvement avant de juger (environ 1,5 s). */
const SAMPLE = 70;
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
  /** Jugements rendus (instant, 90e centile des durées d'image, palier ensuite), pour le banc d'essai. */
  readonly history: { at: number; p90: number; level: number }[];
  /** Les sapins sont arrivés après coup : on leur applique le palier courant. */
  refresh(): void;
  stop(): void;
}

/** Instant de l'image en cours (le même pour tout ce qui s'exécute pendant cette image). */
export function frameTime(): number {
  const t = document.timeline?.currentTime;
  return typeof t === 'number' ? t : performance.now();
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

export function installAdaptiveQuality(map: MlMap, limiter: Pick<FrameLimiter, 'lateMs'>, targets: QualityTargets): QualityController {
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
  let moving = false;
  let last = 0;
  // Pas de jugement pendant le chargement (tuiles, relief, données : toutes les images sont
  // lentes, même sur une machine puissante) ni juste après un allègement (la carte se recompose).
  let judgeAfter = Infinity;
  let slowStreak = 0;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  map.once('idle', () => {
    readyTimer = setTimeout(() => (judgeAfter = performance.now()), SETTLE_MS);
  });

  // Une mesure par image réellement dessinée par la carte, pendant qu'elle bouge.
  const onRender = () => {
    if (!moving) return;
    const now = frameTime();
    // Images où des tuiles arrivent encore : leurs retards viennent du chargement, que l'allègement
    // (densité des sapins, résolution) ne changerait pas. Elles ne comptent pas.
    if (last && now >= judgeAfter && !document.hidden && map.areTilesLoaded()) {
      const dt = now - last;
      if (dt < MAX_DELTA_MS) deltas.push(dt);
    }
    last = now;
    if (deltas.length >= SAMPLE) judge(now);
  };
  const judge = (now: number) => {
    const sorted = [...deltas].sort((a, b) => a - b);
    deltas.length = 0;
    // 90e centile : plus d'une image sur dix en retard se voit, même si l'image typique est à l'heure.
    const slowest = sorted[Math.floor(sorted.length * SLOW_PERCENTILE)];
    // En retard : sous la cadence visée et sous 40 images par seconde (voir FrameLimiter.lateMs).
    slowStreak = slowest > limiter.lateMs ? slowStreak + 1 : 0;
    // Deux fenêtres lentes d'affilée (environ 3 s de mouvement) : une lenteur passagère ne suffit pas.
    if (slowStreak >= SLOW_WINDOWS && level < QUALITY_LEVELS.length - 1) {
      level++;
      slowStreak = 0;
      judgeAfter = now + SETTLE_MS;
      store(level);
      apply();
    }
    history.push({ at: Math.round(now), p90: Math.round(slowest * 10) / 10, level });
    if (history.length > 50) history.shift();
  };
  const start = () => {
    moving = true;
    last = 0;
  };
  const pause = () => {
    moving = false;
  };
  if (!isForced) {
    map.on('movestart', start);
    map.on('moveend', pause);
    map.on('render', onRender);
  }

  return {
    get level() {
      return level;
    },
    history,
    refresh: apply,
    stop() {
      clearTimeout(readyTimer);
      map.off('movestart', start);
      map.off('moveend', pause);
      map.off('render', onRender);
    },
  };
}
