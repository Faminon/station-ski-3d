'use client';

// Fiches d'un lieu, d'une piste ou d'une remontée : mêmes icônes, couleurs et boutons que le
// panneau. Affichées dans une bulle MapLibre (MapPopup.tsx) ou sur la carte Three.js.

import { CalendarOff, CircleCheck, CircleX, Clock, Globe, Navigation, Phone, Ruler, Tractor, X, type LucideIcon } from 'lucide-react';
import type { LiveItemState } from '@/lib/live/types';

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Fermer"
      className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-foreground/45 transition-colors hover:bg-winter-50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

function GoButton({ onClick, label = 'Y aller' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-winter-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
    >
      <Navigation className="h-4 w-4" aria-hidden /> {label}
    </button>
  );
}

function InfoRow({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-snug text-foreground/75">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground/45" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

const siteLabel = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Site web';
  }
};

// ---------------------------------------------------------------------------
// Lieu (restaurant, refuge, point de vue…)

export function PlaceCard({
  name,
  kind,
  color,
  icon: Icon,
  openingHours,
  phone,
  website,
  goLabel,
  onGo,
  onClose,
}: {
  name: string;
  kind: string;
  color: string;
  icon: LucideIcon;
  openingHours?: string;
  phone?: string;
  website?: string;
  /** Texte du bouton (« Y aller » par défaut). */
  goLabel?: string;
  onGo: () => void;
  onClose: () => void;
}) {
  const site = website && /^https?:\/\//i.test(website) ? website : undefined;
  return (
    <div className="relative w-[268px] p-4">
      <CloseButton onClose={onClose} />
      <div className="flex items-start gap-3 pr-8">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: color }}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-lg leading-tight text-foreground">{name}</h3>
          {kind !== name && <p className="mt-0.5 text-[13px] text-foreground/55">{kind}</p>}
        </div>
      </div>
      {(openingHours || phone || site) && (
        <ul className="mt-3 space-y-2 border-t border-winter-100 pt-3">
          {openingHours && <InfoRow icon={Clock}>{openingHours}</InfoRow>}
          {phone && (
            <InfoRow icon={Phone}>
              <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="font-medium text-primary hover:underline">
                {phone}
              </a>
            </InfoRow>
          )}
          {site && (
            <InfoRow icon={Globe}>
              <a href={site} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
                {siteLabel(site)}
              </a>
            </InfoRow>
          )}
        </ul>
      )}
      <GoButton onClick={onGo} label={goLabel} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piste ou remontée : état en direct, motif, damage, horaires.

/** Pictogramme de piste : skieur blanc sur un carré arrondi à la couleur de la piste. */
function SkierBadge({ color }: { color: string }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm" style={{ backgroundColor: color }} aria-hidden>
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="15.2" cy="4.3" r="2.1" fill="#ffffff" stroke="none" />
        <path d="M7.6 9l5-1.7 2.7 3.4-3.1 3.1 2.7 4.1" strokeWidth="2.2" />
        <path d="M12.6 7.4l4.4 3.1" strokeWidth="1.9" />
        <path d="M17 10.5l1.6 5.4" strokeWidth="1.3" />
        <path d="M3.4 16.6l17.2 4.5" strokeWidth="1.9" />
      </svg>
    </span>
  );
}

const STATUS_STYLE = {
  open: { icon: CircleCheck, className: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  closed: { icon: CircleX, className: 'bg-red-50 text-red-800 ring-red-200' },
  out: { icon: CalendarOff, className: 'bg-winter-50 text-foreground/70 ring-winter-200' },
} as const;

export function TrackCard({
  kind,
  name,
  typeLabel,
  color,
  length,
  state,
  outOfSeason,
  liveAvailable,
  demo,
  goLabel,
  onGo,
  onClose,
}: {
  kind: 'piste' | 'lift';
  name: string;
  /** « Piste rouge », « Télésiège débrayable »… */
  typeLabel: string;
  color: string;
  /** Longueur en mètres. */
  length: number;
  state?: LiveItemState;
  /** Domaine hors saison : un tracé sans état est fermé, pas inconnu. */
  outOfSeason: boolean;
  /** Les conditions en direct ont répondu. */
  liveAvailable: boolean;
  demo: boolean;
  goLabel: string;
  onGo: () => void;
  onClose: () => void;
}) {
  const status = state?.status ?? (outOfSeason ? 'out' : null);
  const style = status ? STATUS_STYLE[status] : null;
  const label = state?.label ?? (status === 'out' ? 'Hors saison' : null);
  // Motif d'une fermeture : message de la station, sinon l'état précis (« En attente : vent »).
  const reason = status === 'closed' ? (state?.message ?? (state && state.label !== 'Fermée' ? state.label : undefined)) : state?.message;
  return (
    <div className="relative w-[300px] p-4">
      <CloseButton onClose={onClose} />
      <div className="flex items-start gap-3">
        {kind === 'piste' ? (
          <SkierBadge color={color} />
        ) : (
          <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a1a20] text-white" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6l18-3M8 5.2V12M16 3.8V10" />
              <rect x="5" y="12" width="6" height="5" rx="1.5" />
              <rect x="13" y="10" width="6" height="5" rx="1.5" />
            </svg>
          </span>
        )}
        <div className="min-w-0">
          <h3 className="pr-8 font-display text-lg leading-tight text-foreground">{name}</h3>
          {/* Type (« Piste rouge », « Télésiège ») et état (ouverte, fermée…) sur une même ligne. */}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {kind === 'piste' ? (
              <span
                className="inline-flex items-center rounded-full border-[1.5px] px-2.5 py-0.5 text-[13px] font-semibold"
                style={{ borderColor: color, color, backgroundColor: `${color}14` }}
              >
                {typeLabel}
              </span>
            ) : (
              <span className="text-[13px] text-foreground/55">{typeLabel}</span>
            )}
            {style && label ? (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-semibold ring-1 ${style.className}`}>
                <style.icon className="h-3.5 w-3.5" aria-hidden /> {label}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-winter-50 px-2 py-0.5 text-xs text-foreground/60 ring-1 ring-winter-200">
                {liveAvailable ? 'État non communiqué' : 'État indisponible'}
              </span>
            )}
            {demo && <span className="text-xs font-semibold text-amber-700">simulé</span>}
          </div>
        </div>
      </div>

      {reason && (
        <p className={`mt-2.5 rounded-xl px-3 py-2 text-[13px] leading-snug ${status === 'closed' ? 'bg-red-50/70 text-red-900' : 'bg-winter-50 text-foreground/75'}`}>
          <span className="font-semibold">{status === 'closed' ? 'Motif : ' : 'Info : '}</span>
          {reason}
        </p>
      )}

      <ul className="mt-3 space-y-2 border-t border-winter-100 pt-3">
        {/* Longueur et damage sur une même ligne : fiche plus courte. */}
        <li className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-snug text-foreground/75">
          <span className="inline-flex items-center gap-2.5">
            <Ruler className="h-4 w-4 shrink-0 text-foreground/45" aria-hidden />
            {length >= 1000 ? `${(length / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km` : `${Math.round(length)} m`}
          </span>
          {state?.grooming && (
            <span className="inline-flex items-center gap-2">
              <Tractor className="h-4 w-4 shrink-0 text-foreground/45" aria-hidden />
              {state.grooming}
            </span>
          )}
        </li>
        {state?.hours && <InfoRow icon={Clock}>{state.hours}</InfoRow>}
      </ul>

      <GoButton onClick={onGo} label={goLabel} />
    </div>
  );
}
