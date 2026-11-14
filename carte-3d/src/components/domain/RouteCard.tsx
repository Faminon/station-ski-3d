'use client';

import { useState } from 'react';
import { ArrowUp, Cable, ChevronDown, CornerUpLeft, CornerUpRight, Footprints, Loader2, LocateFixed, MapPin, Navigation, Play, Square, Undo2, X } from 'lucide-react';
import { PISTE_COLORS, type PisteDifficulty } from '@/lib/apis/overpass';
import type { DomainPoi } from '@/lib/domainPois';
import type { RouteResult, RouteStep, RouteTarget, SkiLevel } from '@/lib/skiRouting';
import { DIFFICULTY_SINGULAR, LIFT_LABELS } from '@/lib/skiDomains';
import { formatDistance } from './nearby';

/** Destination demandée : la plus proche d'un type, une station, ou un lieu précis. */
export type RouteGoal =
  | { kind: 'lift' }
  | { kind: 'category'; category: 'restaurant' | 'toilets' }
  | { kind: 'village'; name: string }
  | { kind: 'poi'; poi: DomainPoi }
  /** Un point précis : remontée, piste, station trouvée par la recherche. */
  | { kind: 'place'; place: RouteTarget };

export type RouteStatus = 'idle' | 'preparing' | 'none' | 'ready';

const LEVELS: { id: SkiLevel; label: string }[] = [
  { id: 'all', label: 'Toutes pistes' },
  { id: 'noBlack', label: 'Sans noires' },
  { id: 'easy', label: 'Vertes et bleues' },
];

export function formatDuration(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

/** Icône, intitulé et consigne d'une étape. */
function describeStep(step: RouteStep): { icon: React.ReactNode; title: string; sub: string } {
  let icon: React.ReactNode;
  let title: string;
  let sub: string;
  if (step.kind === 'piste') {
    const color = PISTE_COLORS[step.detail as PisteDifficulty] ?? PISTE_COLORS.unknown;
    icon = <span className="mt-1 h-3 w-3 rounded-full ring-2 ring-white" style={{ backgroundColor: color }} />;
    title = step.name || 'Liaison';
    sub = `Descendre · ${DIFFICULTY_SINGULAR[step.detail as PisteDifficulty] ?? 'Piste'}`;
  } else if (step.kind === 'lift') {
    icon = <Cable className="mt-0.5 h-4 w-4 text-[#7048e8]" />;
    title = step.name || 'Remontée';
    sub = `${step.descending ? 'Redescendre' : 'Monter'} · ${LIFT_LABELS[step.detail] ?? 'Remontée'}`;
  } else {
    icon = <Footprints className="mt-0.5 h-4 w-4 text-foreground/50" />;
    title = 'À pied';
    sub = 'Rejoindre le tracé suivant';
  }
  return { icon, title, sub };
}

/** Étapes à annoncer : les quelques pas d'un tracé à l'autre ne sont pas des consignes. */
const visibleSteps = (r: RouteResult | null) => r?.steps.filter((s) => s.kind !== 'walk' || s.distance >= 40) ?? [];

function StepRow({ step }: { step: RouteStep }) {
  const { icon, title, sub } = describeStep(step);
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="block truncate text-xs text-foreground/50">{sub}</span>
      </span>
      <span className="shrink-0 text-right text-xs tabular-nums text-foreground/55">
        {formatDistance(step.distance)}
        <span className="block text-foreground/40">{formatDuration(step.time)}</span>
      </span>
    </li>
  );
}

export default function RouteCard({
  hasStart,
  startLabel,
  gpsAvailable,
  picking,
  onPickStart,
  onUseGps,
  goal,
  onGoal,
  villages,
  level,
  onLevel,
  status,
  result,
  onStart,
  onSimulate,
  onClose,
}: {
  hasStart: boolean;
  startLabel: string;
  gpsAvailable: boolean;
  picking: boolean;
  onPickStart: () => void;
  onUseGps: () => void;
  goal: RouteGoal | null;
  onGoal: (goal: RouteGoal) => void;
  villages: string[];
  level: SkiLevel;
  onLevel: (level: SkiLevel) => void;
  status: RouteStatus;
  result: RouteResult | null;
  /** Lance le guidage GPS sur cet itinéraire. */
  onStart: () => void;
  /** Essai du guidage avec une position simulée qui parcourt l'itinéraire. */
  onSimulate: () => void;
  onClose: () => void;
}) {
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
      active ? 'border-primary bg-primary text-primary-foreground' : 'border-winter-200 bg-card text-foreground/75 hover:border-primary'
    }`;
  const isGoal = (g: RouteGoal) =>
    !!goal && goal.kind === g.kind && (g.kind !== 'category' || (goal.kind === 'category' && goal.category === g.category));
  const steps = visibleSteps(result);
  // Repliée : seul le résumé reste visible, pour laisser voir le tracé (utile sur téléphone).
  const [folded, setFolded] = useState(false);
  const summary =
    status === 'ready' && result ? (
      <div className="flex items-baseline justify-between rounded-xl bg-winter-50 px-3 py-2">
        <span className="min-w-0 truncate font-semibold text-foreground">{result.target.name}</span>
        <span className="shrink-0 pl-2 text-xs text-foreground/60">
          ≈ <span className="font-semibold text-foreground">{formatDuration(result.time)}</span> · {formatDistance(result.distance)}
        </span>
      </div>
    ) : null;

  return (
    <div className="pointer-events-auto flex max-h-[48vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/60 bg-card/95 text-sm shadow-xl backdrop-blur-md sm:max-h-[70vh]">
      <div className="flex items-center justify-between border-b border-winter-100 px-4 py-3">
        <button type="button" onClick={() => setFolded((f) => !f)} aria-expanded={!folded} className="flex items-center gap-2 font-semibold text-foreground">
          <Navigation className="h-4 w-4 text-primary" /> Itinéraire à ski
          <ChevronDown className={`h-4 w-4 text-foreground/40 transition ${folded ? '-rotate-90' : ''}`} />
        </button>
        <button type="button" onClick={onClose} aria-label="Fermer l'itinéraire" className="rounded-full p-1 text-foreground/40 hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {folded ? (
        <button type="button" onClick={() => setFolded(false)} className="px-4 py-3 text-left">
          {summary ?? <span className="text-xs text-foreground/60">Afficher les réglages de l&apos;itinéraire</span>}
        </button>
      ) : (
      <div className="space-y-3 overflow-y-auto px-4 py-3">
        {/* Départ */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Départ</p>
          {picking ? (
            <p className="rounded-xl bg-winter-50 px-3 py-2 text-xs font-medium text-primary">Touchez la carte à l&apos;endroit du départ…</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {hasStart && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <MapPin className="h-3.5 w-3.5 text-[#1da1f2]" /> {startLabel}
                </span>
              )}
              {gpsAvailable && startLabel !== 'Ma position' && (
                <button type="button" onClick={onUseGps} className={pill(false)}>
                  <LocateFixed className="mr-1 inline h-3 w-3" /> Ma position
                </button>
              )}
              <button type="button" onClick={onPickStart} className={pill(false)}>
                {hasStart ? 'Changer' : 'Choisir sur la carte'}
              </button>
            </div>
          )}
        </div>

        {/* Destination */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Aller vers</p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onGoal({ kind: 'lift' })} className={pill(isGoal({ kind: 'lift' }))}>
              🚡 Remontée la plus proche
            </button>
            <button type="button" onClick={() => onGoal({ kind: 'category', category: 'restaurant' })} className={pill(isGoal({ kind: 'category', category: 'restaurant' }))}>
              🍽️ Restaurant
            </button>
            <button type="button" onClick={() => onGoal({ kind: 'category', category: 'toilets' })} className={pill(isGoal({ kind: 'category', category: 'toilets' }))}>
              🚻 Toilettes
            </button>
            <select
              value={goal?.kind === 'village' ? goal.name : ''}
              onChange={(e) => e.target.value && onGoal({ kind: 'village', name: e.target.value })}
              aria-label="Rejoindre une station"
              className={`${pill(goal?.kind === 'village')} cursor-pointer appearance-none pr-3`}
            >
              <option value="">🏔️ Une station…</option>
              {villages.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          {(goal?.kind === 'poi' || goal?.kind === 'place') && (
            <p className="mt-1.5 text-xs text-foreground/60">
              Vers : <span className="font-medium text-foreground">{goal.kind === 'poi' ? goal.poi.name : goal.place.name}</span>
            </p>
          )}
        </div>

        {/* Niveau */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Pistes empruntées</p>
          <div className="flex flex-wrap gap-1.5">
            {LEVELS.map((l) => (
              <button key={l.id} type="button" onClick={() => onLevel(l.id)} className={pill(level === l.id)} aria-pressed={level === l.id}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* Résultat */}
        {!hasStart && !picking && goal && <p className="text-xs text-foreground/60">Choisissez un point de départ pour calculer l&apos;itinéraire.</p>}
        {status === 'preparing' && (
          <p className="flex items-center gap-2 text-xs text-foreground/60">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Préparation du réseau de pistes…
          </p>
        )}
        {status === 'none' && hasStart && goal && (
          <p className="rounded-xl bg-accent-50 px-3 py-2 text-xs text-foreground/70">
            Aucun itinéraire à ski trouvé depuis ce point{level !== 'all' ? ' avec ce niveau de pistes' : ''}. Rapprochez le départ d&apos;une piste
            {level !== 'all' ? ' ou élargissez le choix des pistes' : ''}.
          </p>
        )}
        {status === 'ready' && result && (
          <div>
            {summary}
            <button
              type="button"
              onClick={onStart}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground shadow-md shadow-primary/20 transition hover:bg-primary/90"
            >
              <Play className="h-4 w-4 fill-current" /> Démarrer le guidage
            </button>
            <button
              type="button"
              onClick={onSimulate}
              className="mt-1.5 w-full rounded-xl border border-winter-200 px-4 py-2 text-xs font-semibold text-foreground/70 transition hover:border-primary hover:text-primary"
            >
              Simuler le trajet (position fictive, en accéléré)
            </button>
            <ol className="mt-1 divide-y divide-winter-100">
              {steps.map((s, i) => (
                <StepRow key={i} step={s} />
              ))}
            </ol>
            <p className="mt-2 text-[11px] leading-snug text-foreground/40">
              Temps indicatif (attente aux remontées comprise). Vérifiez l&apos;ouverture des pistes et remontées sur place.
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * Guidage en cours : consigne de l'étape actuelle en haut de l'écran, arrivée
 * estimée et arrêt en bas. L'itinéraire est recalculé à mesure que le skieur
 * avance : la première étape est toujours celle où il se trouve.
 */
export function NavigationBar({
  route,
  gpsPending,
  simulated,
  topClass,
  onStop,
}: {
  route: RouteResult | null;
  /** Position GPS pas encore reçue : l'itinéraire affiché part du point choisi sur la carte. */
  gpsPending: boolean;
  /** Position simulée (démonstration). */
  simulated: boolean;
  topClass: string;
  onStop: () => void;
}) {
  const steps = visibleSteps(route);
  const current = steps[0];
  const next = steps[1];
  const turn = current && next ? turnBetween(current, next) : null;
  const TurnIcon = turn ? TURN_ICONS[turn] : ArrowUp;
  return (
    <>
      <div className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3 ${topClass}`}>
        <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl bg-winter-900/95 text-white shadow-2xl backdrop-blur-md">
          {!current ? (
            <p className="flex items-center gap-2 px-4 py-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> En attente de votre position…
            </p>
          ) : (
            <>
              <div className="px-4 pb-3 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <StepBadge step={current} />
                  <span className="text-lg font-bold tabular-nums">{formatDistance(current.distance)}</span>
                </div>
                <p className="mt-1.5 truncate font-display text-2xl leading-tight">{stepTitle(current, next, route?.target.name)}</p>
                <p className="mt-0.5 text-sm text-white/75">{instruction(current)}</p>
              </div>
              {next && (
                <div className="flex items-center gap-3 border-t border-white/10 bg-white/5 px-4 py-2">
                  <TurnIcon className="h-7 w-7 shrink-0 text-white" strokeWidth={2.5} />
                  <p className="min-w-0 flex-1 text-sm leading-snug">
                    <span className="text-white/70">Puis {turn ? TURN_TEXT[turn] : 'tout droit'} :</span>{' '}
                    <span className="font-semibold">{nextAction(next)}</span>
                  </p>
                  <StepBadge step={next} small />
                </div>
              )}
              {!next && <p className="border-t border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80">Puis arrivée : <span className="font-semibold text-white">{route?.target.name}</span></p>}
              {gpsPending && !simulated && (
                <p className="flex items-center gap-2 border-t border-white/10 bg-[#f08c00]/25 px-4 py-1.5 text-xs text-white">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> Recherche du GPS… itinéraire affiché depuis le départ choisi.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-white/60 bg-card/95 px-4 py-3 shadow-xl backdrop-blur-md">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{route?.target.name ?? 'Itinéraire'}</span>
              {simulated && <span className="shrink-0 rounded-full bg-[#f08c00]/15 px-2 py-0.5 text-[10px] font-bold uppercase text-[#e8590c]">Simulation</span>}
            </span>
            {route && (
              <span className="block text-xs text-foreground/55">
                Arrivée dans ≈ <span className="font-semibold text-foreground">{formatDuration(route.time)}</span> · {formatDistance(route.distance)}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onStop}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#e03131] px-3 py-2 text-xs font-bold text-white hover:bg-[#c92a2a]"
          >
            <Square className="h-3 w-3 fill-current" /> Arrêter
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Consignes du guidage : type et couleur de chaque étape, sens du prochain virage.

/** Couleur des remontées sur l'itinéraire guidé (les pistes gardent la leur). */
export const ROUTE_LIFT_COLOR = '#fab005';
/** Passages à pied : bleu clair, lisible sur la neige comme sur la roche. */
export const ROUTE_WALK_COLOR = '#4dabf7';

type Turn = 'straight' | 'left' | 'right' | 'back';
const TURN_ICONS = { straight: ArrowUp, left: CornerUpLeft, right: CornerUpRight, back: Undo2 };
const TURN_TEXT: Record<Turn, string> = { straight: 'tout droit', left: 'à gauche', right: 'à droite', back: 'faites demi-tour' };

function stepColor(step: RouteStep): string {
  if (step.kind === 'lift') return ROUTE_LIFT_COLOR;
  if (step.kind === 'walk') return ROUTE_WALK_COLOR;
  return PISTE_COLORS[step.detail as PisteDifficulty] ?? PISTE_COLORS.unknown;
}

function stepKindLabel(step: RouteStep): string {
  if (step.kind === 'lift') return LIFT_LABELS[step.detail] ?? 'Remontée';
  if (step.kind === 'walk') return 'À pied';
  return DIFFICULTY_SINGULAR[step.detail as PisteDifficulty] ?? 'Piste';
}

/** Étiquette du type d'étape, à sa couleur : « PISTE ROUGE », « TÉLÉSIÈGE »… */
function StepBadge({ step, small = false }: { step: RouteStep; small?: boolean }) {
  const color = stepColor(step);
  // Texte sombre sur le jaune des remontées, clair ailleurs.
  const dark = step.kind === 'lift';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full font-bold uppercase tracking-wide ring-2 ring-white/80 ${
        small ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
      }`}
      style={{ backgroundColor: color, color: dark ? '#1a1a20' : '#ffffff' }}
    >
      {step.kind === 'lift' ? <Cable className="h-3 w-3" /> : step.kind === 'walk' ? <Footprints className="h-3 w-3" /> : null}
      {small && step.kind === 'piste' ? (step.detail === 'unknown' ? 'Piste' : stepKindLabel(step).replace('Piste ', '')) : stepKindLabel(step)}
    </span>
  );
}

// L'étiquette porte déjà le type et la couleur ; le titre donne le nom, la consigne l'action.

/** Titre de l'étape en cours : son nom, ou pour la marche, ce qu'elle rejoint. */
function stepTitle(step: RouteStep, next: RouteStep | undefined, targetName: string | undefined): string {
  if (step.kind === 'walk') return next ? `Vers ${next.name || (next.kind === 'lift' ? 'la remontée' : 'la piste')}` : `Vers ${targetName ?? "l'arrivée"}`;
  return step.name || (step.kind === 'lift' ? 'Remontée' : 'Liaison');
}

/** Consigne de l'étape en cours, sans répéter le nom ni la couleur. */
function instruction(step: RouteStep): string {
  if (step.kind === 'lift') return step.descending ? "Redescendez jusqu'à la gare du bas." : "Montez jusqu'à la gare du haut.";
  if (step.kind === 'walk') return 'Continuez à pied.';
  return 'Descendez la piste.';
}

/** Action de l'étape suivante, sans répéter le type indiqué par l'étiquette. */
function nextAction(step: RouteStep): string {
  if (step.kind === 'lift') return step.name || 'la remontée';
  if (step.kind === 'walk') return 'à pied';
  return step.name || 'la liaison';
}

/** Cap (degrés) entre deux points [lng, lat]. */
function heading(a: number[], b: number[]): number {
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  return (Math.atan2(dx, b[1] - a[1]) * 180) / Math.PI;
}

/** Point situé à `meters` mètres d'un bout de la ligne (depuis la fin si `fromEnd`). */
function alongLine(coords: number[][], meters: number, fromEnd: boolean): number[] {
  const pts = fromEnd ? [...coords].reverse() : coords;
  let left = meters;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot((pts[i][0] - pts[i - 1][0]) * 111_320 * Math.cos((pts[i][1] * Math.PI) / 180), (pts[i][1] - pts[i - 1][1]) * 110_574);
    if (d >= left) return [pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * left) / d, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * left) / d];
    left -= d;
  }
  return pts[pts.length - 1];
}

/** Sens du virage pour passer d'une étape à la suivante, d'après la direction des tracés autour du raccord. */
function turnBetween(a: RouteStep, b: RouteStep): Turn {
  const end = a.coordinates[a.coordinates.length - 1];
  const before = alongLine(a.coordinates, 60, true);
  const after = alongLine(b.coordinates, 60, false);
  if (!end || !before || !after) return 'straight';
  let delta = heading(end, after) - heading(before, end);
  delta = ((delta + 540) % 360) - 180;
  if (Math.abs(delta) > 140) return 'back';
  if (Math.abs(delta) < 30) return 'straight';
  return delta < 0 ? 'left' : 'right';
}
