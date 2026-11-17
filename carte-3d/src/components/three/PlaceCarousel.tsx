'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clock, Globe, Navigation, Phone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DomainPoi } from '@/lib/domainPois';

/** Distance (px) d'un glissé vers le bas qui range les fiches. */
const HIDE_DRAG_PX = 70;

/**
 * Fiches des lieux d'un type (restaurants, refuges…), en bas de l'écran, comme Google Maps :
 * on fait défiler d'un lieu à l'autre d'un glissé horizontal (la carte va sur le lieu affiché),
 * un glissé vers le bas range les fiches et rend la carte libre.
 */
export default function PlaceCarousel({
  places,
  index,
  onIndex,
  color,
  icon: Icon,
  label,
  onGo,
  onHide,
}: {
  places: DomainPoi[];
  index: number;
  onIndex: (i: number) => void;
  color: string;
  icon: LucideIcon;
  /** Nom du type, au pluriel (« Restaurants »). */
  label: string;
  onGo: (poi: DomainPoi) => void;
  onHide: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const swipe = useRef<{ x: number; y: number; vertical: boolean | null } | null>(null);

  // Fiche à montrer choisie ailleurs (pastille touchée sur la carte) : on y fait défiler.
  useEffect(() => {
    const el = scroller.current;
    const card = el?.children[index] as HTMLElement | undefined;
    if (!el || !card) return;
    const left = card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2;
    if (Math.abs(el.scrollLeft - left) > 4) el.scrollTo({ left, behavior: 'smooth' });
  }, [index]);

  // Fiche au centre après un défilement : elle devient le lieu affiché.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const el = scroller.current;
      if (!el) return;
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let bestD = Infinity;
      [...el.children].forEach((c, i) => {
        const card = c as HTMLElement;
        const d = Math.abs(card.offsetLeft + card.offsetWidth / 2 - mid);
        if (d < bestD) [best, bestD] = [i, d];
      });
      if (best !== index) onIndex(best);
    }, 120);
  };

  // Glissé vers le bas : la carte suit le doigt, puis se range au-delà du seuil.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipe.current = { x: t.clientX, y: t.clientY, vertical: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (s.vertical === null && Math.hypot(dx, dy) > 8) s.vertical = Math.abs(dy) > Math.abs(dx);
    if (s.vertical) setDragY(Math.max(0, dy));
  };
  const onTouchEnd = () => {
    const hide = swipe.current?.vertical && dragY > HIDE_DRAG_PX;
    swipe.current = null;
    setDragY(0);
    if (hide) onHide();
  };

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      style={{ transform: `translateY(${dragY}px)`, transition: dragY ? 'none' : 'transform 200ms ease-out', opacity: 1 - Math.min(0.5, dragY / 300) }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* Poignée : rappelle qu'on peut ranger les fiches d'un glissé vers le bas. */}
      <div className="mb-1.5 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={onHide}
          aria-label="Ranger les fiches"
          className="flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1 text-xs font-semibold text-foreground/70 shadow backdrop-blur"
        >
          <span className="tabular-nums">
            {index + 1} / {places.length}
          </span>
          <span className="text-foreground/35">·</span>
          {label}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex snap-x snap-mandatory gap-2.5 overflow-x-auto overscroll-x-contain px-[7.5vw] [scrollbar-width:none] sm:px-[calc(50%-170px)] [&::-webkit-scrollbar]:hidden"
      >
        {places.map((p, i) => {
          const site = p.website && /^https?:\/\//i.test(p.website) ? p.website : undefined;
          return (
            <article
              key={p.id}
              onClick={() => i !== index && onIndex(i)}
              className={`w-[85vw] max-w-[340px] shrink-0 snap-center rounded-2xl bg-card p-3.5 shadow-[0_8px_28px_rgb(28_46_64/0.22)] transition-opacity ${i === index ? 'opacity-100' : 'opacity-80'}`}
            >
              <div className="flex items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: color }}>
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-display text-lg leading-tight text-foreground">{p.name || label}</h3>
                  <p className="truncate text-[13px] text-foreground/55">{p.kind}</p>
                  {p.openingHours && (
                    <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-foreground/65">
                      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{p.openingHours}</span>
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onGo(p);
                  }}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-primary-foreground hover:bg-winter-700"
                >
                  <Navigation className="h-4 w-4" aria-hidden /> Y aller
                </button>
                {p.phone && (
                  <a
                    href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}
                    aria-label={`Appeler ${p.name}`}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-winter-200 text-primary hover:bg-winter-50"
                  >
                    <Phone className="h-4 w-4" />
                  </a>
                )}
                {site && (
                  <a
                    href={site}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Site de ${p.name}`}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-winter-200 text-primary hover:bg-winter-50"
                  >
                    <Globe className="h-4 w-4" />
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
