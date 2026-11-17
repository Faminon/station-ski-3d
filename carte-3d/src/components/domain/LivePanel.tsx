'use client';

import { ArrowUpRight, CableCar, CalendarOff, FlaskConical, Mountain, Thermometer, TriangleAlert, Wind } from 'lucide-react';
import type { LiveConditions, LiveSource, VigilanceColor, WeatherPoint } from '@/lib/live/types';
import { weatherIcon } from './panelIcons';
import type { LiveState } from './useLiveConditions';

export const RISK_LABELS = ['', 'faible', 'limité', 'marqué', 'fort', 'très fort'];

/**
 * Pictogramme du risque d'avalanche, de 1 à 5, sur le modèle de l'échelle européenne : losange
 * à la couleur du niveau, sommet de montagne noir enneigé, symbole du niveau (coche, « ! »,
 * « !! », croix) et nuage aux niveaux 4 et 5 ; damier rouge et noir au niveau 5.
 * Utilisé sur la carte et dans le panneau.
 */
export function AvalancheRiskIcon({ risk, className = 'h-11 w-11' }: { risk: number; className?: string }) {
  const fill = ['#ced4da', '#ccff66', '#ffff00', '#ff9900', '#ff0000', '#ff0000'][risk] ?? '#ced4da';
  const id = `aval-${risk}`;
  // Losange : haut (32,4), droite (60,32), bas (32,60), gauche (4,32).
  const diamond = '32,4 60,32 32,60 4,32';
  return (
    <svg viewBox="0 0 64 64" className={`shrink-0 ${className}`} role="img" aria-label={`Risque d'avalanche ${risk} sur 5, ${RISK_LABELS[risk] ?? ''}`}>
      <defs>
        <clipPath id={`${id}-clip`}>
          <polygon points={diamond} />
        </clipPath>
        {risk === 5 && (
          <pattern id={`${id}-check`} width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="#ff0000" />
            <rect width="6" height="6" fill="#111" />
            <rect x="6" y="6" width="6" height="6" fill="#111" />
          </pattern>
        )}
      </defs>
      <polygon points={diamond} fill={risk === 5 ? `url(#${id}-check)` : fill} />
      <g clipPath={`url(#${id}-clip)`}>
        {/* Sommet noir et pente enneigée. */}
        <polygon points="32,4 52,24 45,21 39,25 33,19 26,24 20,21 12,24" fill="#111" />
        <polygon points="33,19 39,25 45,21 52,24 54,27 44,25 38,28 32,23 26,27 18,24 20,21 26,24" fill="#fff" />
      </g>
      <polygon points={diamond} fill="none" stroke="#111" strokeWidth="2.5" strokeLinejoin="round" />
      {/* Symbole du niveau. */}
      {risk === 1 && <path d="M23 40 L30 47 L42 32" fill="none" stroke="#111" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />}
      {risk === 2 && (
        <g fill="#111">
          <rect x="29.5" y="29" width="5" height="13" rx="1.5" />
          <circle cx="32" cy="47" r="2.8" />
        </g>
      )}
      {risk === 3 && (
        <g fill="#111">
          <rect x="24.5" y="29" width="5" height="13" rx="1.5" />
          <circle cx="27" cy="47" r="2.8" />
          <rect x="34.5" y="29" width="5" height="13" rx="1.5" />
          <circle cx="37" cy="47" r="2.8" />
        </g>
      )}
      {risk >= 4 && (
        <path d="M24 32 L40 48 M40 32 L24 48" stroke={risk === 5 ? '#fff' : '#111'} strokeWidth="5" strokeLinecap="round" />
      )}
      {/* Nuage des niveaux 4 et 5. */}
      {risk >= 4 && (
        <path
          d="M45 15 a4.5 4.5 0 0 1 8.2 -2.2 a4 4 0 0 1 7 3.2 a3.4 3.4 0 0 1 -0.7 6.7 h-13.8 a3.9 3.9 0 0 1 -0.7 -7.7 z"
          fill="#fff"
          stroke="#555"
          strokeWidth="1.3"
        />
      )}
    </svg>
  );
}
const VIGILANCE: Record<VigilanceColor, { label: string; color: string }> = {
  1: { label: 'verte', color: '#2fa84f' },
  2: { label: 'jaune', color: '#f2d21b' },
  3: { label: 'orange', color: '#f08a1c' },
  4: { label: 'rouge', color: '#d7261e' },
};

/** Opacité d'un tracé fermé ou hors saison, sur la carte (Domain3DViewer) comme dans la légende. */
export const LIVE_CLOSED_OPACITY = 0.45;

const WIND_FROM = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const windFrom = (deg: number | null) => (deg === null ? '' : WIND_FROM[Math.round(deg / 45) % 8]);

const round = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('fr-FR'));

/** « 14:05 », ou « 14 nov. 14:05 » si ce n'est pas aujourd'hui (heure de Paris). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const zone = { timeZone: 'Europe/Paris' } as const;
  const time = d.toLocaleTimeString('fr-FR', { ...zone, hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toLocaleDateString('fr-FR', zone) === new Date().toLocaleDateString('fr-FR', zone);
  return sameDay ? time : `${d.toLocaleDateString('fr-FR', { ...zone, day: 'numeric', month: 'short' })} ${time}`;
}

const dayLabel = (date: string, i: number) =>
  i === 0 ? "Aujourd'hui" : i === 1 ? 'Demain' : new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long' });

/**
 * Source sous une carte : nom et heure de la donnée. Une source muette est dite « indisponible » ;
 * la raison technique (clé absente, service muet) reste dans l'infobulle, pas dans le texte.
 */
function SourceLine({ source, stale }: { source: LiveSource; stale?: boolean }) {
  const warn = !source.ok || stale;
  return (
    <p className={`mt-3 text-[11px] ${warn ? 'text-amber-800' : 'text-foreground/45'}`} title={source.ok ? undefined : source.note}>
      {source.ok ? `${source.name} · ${formatTime(source.updatedAt)}${stale ? ' · rafraîchissement en échec' : ''}` : `${source.name} · indisponible`}
    </p>
  );
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-winter-100 bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        {aside && <span className="truncate text-xs text-foreground/50">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 inline-flex min-h-9 items-center gap-1 rounded-full bg-winter-50 px-3 text-xs font-semibold text-primary transition-colors hover:bg-winter-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {children} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

/** Teinte d'un taux d'ouverture : vert (bien ouvert), ambre (en partie), gris (presque tout fermé). */
function shareTone(share: number) {
  if (share >= 0.6) return { bar: 'bg-emerald-500', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
  if (share >= 0.25) return { bar: 'bg-amber-500', pill: 'bg-amber-50 text-amber-800 ring-amber-200' };
  return { bar: 'bg-slate-400', pill: 'bg-slate-100 text-slate-600 ring-slate-200' };
}

/** Un chiffre « ouvertes / total » avec son icône et sa jauge. */
function Stat({ icon: Icon, label, open, total }: { icon: typeof Mountain; label: string; open: number; total: number }) {
  const share = total ? open / total : 0;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-xs text-foreground/60">
        <Icon className="h-3.5 w-3.5 shrink-0 text-winter-600" aria-hidden />
        {label}
      </div>
      <p className="mt-0.5 tabular-nums leading-none">
        <span className="text-2xl font-bold text-foreground">{open}</span>
        <span className="text-sm font-medium text-foreground/40"> / {total}</span>
      </p>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-winter-100"
        role="meter"
        aria-label={`${label} ouvertes`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={open}
      >
        <div className={`h-full rounded-full transition-[width] duration-500 ${shareTone(share).bar}`} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/** Une station : son nom, la part du domaine ouverte, pistes et remontées. */
function ResortTile({ name, pistesOpen, pistesTotal, liftsOpen, liftsTotal }: { name: string; pistesOpen: number; pistesTotal: number; liftsOpen: number; liftsTotal: number }) {
  const total = pistesTotal + liftsTotal;
  const share = total ? (pistesOpen + liftsOpen) / total : 0;
  const pct = Math.round(share * 100);
  return (
    <li className="rounded-xl bg-winter-50/70 p-3 ring-1 ring-inset ring-winter-100">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="truncate text-[15px] font-semibold text-foreground">{name}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset ${shareTone(share).pill}`}>
          {pct === 0 ? 'Fermé' : `Ouvert à ${pct} %`}
        </span>
      </div>
      <div className="flex gap-4">
        <Stat icon={Mountain} label="Pistes" open={pistesOpen} total={pistesTotal} />
        <Stat icon={CableCar} label="Remontées" open={liftsOpen} total={liftsTotal} />
      </div>
    </li>
  );
}

function Openings({ live, stale }: { live: LiveConditions; stale: boolean }) {
  const o = live.openings;
  return (
    <Card title="Pistes et remontées">
      {!o.source.ok ? (
        <p className="text-[13px] text-foreground/65">État des pistes indisponible : la carte les montre sans état.</p>
      ) : (
        <>
          {o.outOfSeason && (
            <p className="mb-3 flex items-start gap-2 rounded-xl bg-winter-50 px-3 py-2.5 text-[13px] leading-snug text-foreground/80">
              <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-winter-600" aria-hidden />
              Hors saison : pistes et remontées sont estompées sur la carte.
            </p>
          )}
          <ul className="space-y-2">
            {o.resorts.map((r) => (
              <ResortTile key={r.name} {...r} />
            ))}
          </ul>
        </>
      )}
      <SourceLine source={o.source} stale={stale} />
    </Card>
  );
}

function Avalanche({ live, stale }: { live: LiveConditions; stale: boolean }) {
  const a = live.avalanche;
  const vigilance = live.vigilance.phenomena.find((p) => p.label === 'Avalanches');
  return (
    <Card title="Risque d'avalanche" aside={a.massif}>
      {a.risk ? (
        <div className="flex items-start gap-3">
          <AvalancheRiskIcon risk={a.risk} />
          <div className="min-w-0 space-y-0.5 text-[13px] leading-snug">
            <p className="font-semibold text-foreground">Risque {RISK_LABELS[a.risk]}</p>
            {a.levels.length > 0 && <p className="text-foreground/70">{a.levels.map((l) => `${l.label} : ${l.risk}`).join(' · ')}</p>}
            {a.slopes && a.slopes.length > 0 && <p className="text-foreground/70">Pentes les plus exposées : {a.slopes.join(', ')}</p>}
            {a.comment && <p className="text-foreground/60">{a.comment}</p>}
            {a.validUntil && <p className="text-xs text-foreground/50">Valable jusqu&apos;au {formatTime(a.validUntil)}</p>}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-winter-50 text-winter-600"
            style={vigilance ? { backgroundColor: VIGILANCE[vigilance.color].color, color: vigilance.color >= 3 ? '#fff' : '#111' } : undefined}
          >
            <TriangleAlert className="h-5 w-5" aria-hidden />
          </span>
          <p className="min-w-0 text-[13px] leading-snug text-foreground/70">
            {vigilance ? (
              <>
                <span className="font-semibold text-foreground">Vigilance avalanches {VIGILANCE[vigilance.color].label}</span> sur le département. Bulletin du massif non
                disponible ici.
              </>
            ) : (
              'Bulletin du massif non disponible ici.'
            )}
          </p>
        </div>
      )}
      {a.snow && a.snow.length > 0 && (
        <p className="mt-3 text-xs text-foreground/65">
          Neige hors-piste (nord / sud) : {a.snow.map((s) => `${s.altitude.toLocaleString('fr-FR')} m ${s.north} / ${s.south} cm`).join(' · ')}
        </p>
      )}
      <p className="mt-3 text-xs text-foreground/50">Concerne le hors-piste, pas les pistes balisées et ouvertes.</p>
      <ExternalButton href={a.url}>Bulletin Météo-France</ExternalButton>
      <SourceLine source={a.source} stale={stale} />
    </Card>
  );
}

function VigilanceCard({ live, stale }: { live: LiveConditions; stale: boolean }) {
  const v = live.vigilance;
  const color = v.color ? VIGILANCE[v.color] : null;
  return (
    <Card title="Vigilance météo" aside={v.area}>
      {color ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full bg-winter-50 py-1 pl-1.5 pr-3 text-[13px] font-semibold text-foreground">
            <span className="h-4 w-4 rounded-full ring-1 ring-black/10" style={{ backgroundColor: color.color }} />
            {v.phenomena.length === 0 ? 'Pas de vigilance particulière' : `Vigilance ${color.label}`}
          </span>
          {v.phenomena.length > 0 && <span className="text-[13px] text-foreground/70">{v.phenomena.map((p) => p.label).join(', ')}</span>}
        </div>
      ) : (
        <p className="text-[13px] text-foreground/65">Vigilance indisponible.</p>
      )}
      <ExternalButton href={v.url}>Carte de vigilance</ExternalButton>
      <SourceLine source={v.source} stale={stale} />
    </Card>
  );
}

function PointRow({ p }: { p: WeatherPoint }) {
  const { Icon, label } = weatherIcon(p.weatherCode, p.isDay);
  const gusts = p.windGusts !== null && p.windGusts > (p.windSpeed ?? 0) + 10;
  return (
    <li className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-winter-50 text-winter-700" title={label}>
        <Icon className="h-5 w-5" aria-label={label || undefined} aria-hidden={!label} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-foreground">{p.name}</span>
        <span className="block text-xs text-foreground/55">
          {p.altitude.toLocaleString('fr-FR')} m{p.snowDepth ? ` · neige au sol ≈ ${p.snowDepth} cm` : ''}
        </span>
      </span>
      <span className="text-right tabular-nums">
        <span className="block font-display text-xl leading-none text-foreground">{round(p.temperature)}°</span>
        <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-foreground/55">
          <Wind className="h-3 w-3" aria-hidden />
          {windFrom(p.windDirection)} {round(p.windSpeed)}
          {gusts ? `–${round(p.windGusts)}` : ''} km/h
        </span>
      </span>
    </li>
  );
}

function Weather({ live, stale }: { live: LiveConditions; stale: boolean }) {
  const w = live.weather;
  // Neige prévue et vent : au point le plus haut, le plus parlant pour le domaine skiable.
  const top = w.points.reduce<WeatherPoint | null>((a, b) => (!a || b.altitude > a.altitude ? b : a), null);
  return (
    <Card title="Météo">
      {w.points.length === 0 ? (
        <p className="text-[13px] text-foreground/65">Prévisions indisponibles.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {w.points.map((p) => (
              <PointRow key={p.name} p={p} />
            ))}
          </ul>
          {top && top.days.length > 0 && (
            <>
              <p className="mb-2 mt-4 text-xs text-foreground/55">Prévisions à {top.altitude.toLocaleString('fr-FR')} m</p>
              <ol className="grid grid-cols-3 gap-2">
                {top.days.slice(0, 3).map((d, i) => {
                  const { Icon, label } = weatherIcon(d.weatherCode);
                  return (
                    <li key={d.date} className="rounded-xl bg-winter-50 px-2 py-2.5 text-center">
                      <p className="truncate text-xs font-semibold capitalize text-foreground/80">{dayLabel(d.date, i)}</p>
                      <Icon className="mx-auto my-1.5 h-5 w-5 text-winter-700" aria-label={label || undefined} aria-hidden={!label} />
                      <p className="tabular-nums text-xs text-foreground">
                        <span className="text-foreground/55">{round(d.min)}°</span> / <span className="font-semibold">{round(d.max)}°</span>
                      </p>
                      <p className="mt-0.5 tabular-nums text-[11px] text-foreground/55">{d.snowfall ? `${Math.round(d.snowfall)} cm de neige` : 'sans neige'}</p>
                      <p className="tabular-nums text-[11px] text-foreground/55">rafales {round(d.gusts)}</p>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {w.freezingLevel !== null && (
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-foreground/65">
              <Thermometer className="h-3.5 w-3.5" aria-hidden /> Isotherme 0 °C : {round(w.freezingLevel)} m
            </p>
          )}
        </>
      )}
      <SourceLine source={{ ...w.source, name: `${w.source.name} (modèles Météo-France), CC BY 4.0` }} stale={stale} />
    </Card>
  );
}

/** Onglet « Conditions » du panneau du domaine : état des pistes, avalanche, vigilance, météo. */
/** Noms des sources sans « Simulation · … » (journée simulée présentée comme une vraie). */
const REAL_SOURCE_NAMES = { openings: 'Lumiplan (stations)', avalanche: 'Météo-France' };

/**
 * Panneau des conditions en direct. `weather` (vrai par défaut) : blocs météo et vigilance ; la
 * carte Three.js les masque pour un panneau plus court (ouvertures et avalanche seulement).
 * `demoNotice` (vrai par défaut) : la journée simulée est signalée (bandeau, sources, bouton pour
 * l'activer hors saison). La carte Three.js l'efface (présentations) : la simulation ne s'y
 * active alors que par l'adresse (?demo=saison), jamais par un bouton qu'un visiteur toucherait.
 */
export default function LivePanel({
  state,
  demo,
  onToggleDemo,
  weather = true,
  demoNotice = true,
}: {
  state: LiveState;
  demo: boolean;
  onToggleDemo: () => void;
  weather?: boolean;
  demoNotice?: boolean;
}) {
  const { failed } = state;
  const data =
    state.data && state.data.demo && !demoNotice
      ? {
          ...state.data,
          openings: { ...state.data.openings, source: { ...state.data.openings.source, name: REAL_SOURCE_NAMES.openings } },
          avalanche: state.data.avalanche && { ...state.data.avalanche, source: { ...state.data.avalanche.source, name: REAL_SOURCE_NAMES.avalanche } },
        }
      : state.data;
  if (!data) {
    return (
      <p className="rounded-2xl border border-winter-100 bg-card px-4 py-3 text-[13px] text-foreground/65">
        {failed ? 'Conditions en direct indisponibles pour le moment : la carte reste utilisable sans elles.' : 'Chargement des conditions…'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {data.demo && demoNotice && (
        <p className="flex items-start gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] leading-snug text-amber-900">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Simulation d&apos;un jour de pleine saison.</span> États des pistes, avalanche et météo sont fictifs.
            <button type="button" onClick={onToggleDemo} className="mt-1.5 block font-semibold underline underline-offset-2 hover:no-underline">
              Revenir aux vraies conditions
            </button>
          </span>
        </p>
      )}
      {demoNotice && !data.demo && !demo && data.openings.outOfSeason && (
        <button
          type="button"
          onClick={onToggleDemo}
          className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-winter-300 bg-card px-4 py-3 text-left transition-colors hover:border-primary hover:bg-winter-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <FlaskConical className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-foreground">Voir un jour de pleine saison</span>
            <span className="block text-xs text-foreground/55">Simulation : pistes ouvertes, météo et avalanche fictives</span>
          </span>
        </button>
      )}
      <p className="flex items-center gap-2 px-1 text-xs text-foreground/55">
        <span className={`h-2 w-2 rounded-full ${failed || (data.demo && demoNotice) ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden />
        {failed
          ? `Données de ${formatTime(data.generatedAt)} (rafraîchissement en échec)`
          : data.demo && demoNotice
            ? `Simulation générée à ${formatTime(data.generatedAt)}`
            : `En direct · mis à jour à ${formatTime(data.generatedAt)}`}
      </p>
      <Openings live={data} stale={failed} />
      {weather && <Weather live={data} stale={failed} />}
      <Avalanche live={data} stale={failed} />
      {weather && <VigilanceCard live={data} stale={failed} />}
    </div>
  );
}
