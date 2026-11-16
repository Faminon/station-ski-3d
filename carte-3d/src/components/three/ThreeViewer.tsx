'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, LocateFixed, Maximize2, Navigation, RotateCw, Search, Snowflake, X } from 'lucide-react';
import { DIFFICULTY_LABELS, PISTE_COLORS, type PisteDifficulty } from '@/lib/apis/overpass';
import { DOMAIN_POI_CATEGORIES, type DomainPoi, type DomainPoiCategoryId } from '@/lib/domainPois';
import { DIFFICULTY_SINGULAR, LIFT_LABELS, type SkiDomainConfig } from '@/lib/skiDomains';
import type { LiveItemState } from '@/lib/live/types';
import LivePanel from '@/components/domain/LivePanel';
import { PlaceCard, TrackCard } from '@/components/domain/MapCards';
import { formatDistance, nearestLine } from '@/components/domain/nearby';
import { POI_ICONS } from '@/components/domain/panelIcons';
import RouteCard, { NavigationBar } from '@/components/domain/RouteCard';
import { useLiveConditions } from '@/components/domain/useLiveConditions';
import { loadDomainData, type DomainData, type TrackLine } from './domainData';
import { trackColor } from './overlays';
import { createScene, type LabelHandle, type SceneHandle, type SceneStats } from './scene';
import { useRouting } from './useRouting';

/**
 * Carte 3D du domaine en Three.js (WebGPU) : relief, pistes, remontées, sapins, lieux,
 * recherche, position GPS, conditions en direct, itinéraires et guidage, avec un compteur
 * pour la comparer à la carte MapLibre (/carte/…).
 */

const CATEGORY = new Map(DOMAIN_POI_CATEGORIES.map((c) => [c.id, c]));
const DIFFICULTIES: PisteDifficulty[] = ['green', 'blue', 'red', 'black'];
const normalize = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isWide = () => window.innerWidth >= 640;
/** Lieux masqués au-delà de cette distance de la caméra (m) : la vue d'ensemble reste lisible. */
const POI_MAX_DISTANCE = 9000;
/** Au-delà de cette distance des pistes, on est hors du domaine (m). */
const OFF_DOMAIN_M = 2000;

type Selection =
  | { kind: 'track'; tracks: TrackLine[]; at: [number, number] }
  | { kind: 'poi'; poi: DomainPoi }
  | { kind: 'here' };

interface SearchEntry {
  id: string;
  name: string;
  sub: string;
  emoji?: string;
  color?: string;
  lng: number;
  lat: number;
  poi?: DomainPoi;
  tracks?: TrackLine[];
  bearing?: number;
}

interface Here {
  lng: number;
  lat: number;
  accuracy: number;
}

type PanelTab = 'explore' | 'conditions';

/** Tous les tronçons d'une piste ou d'une remontée nommée (une liaison sans nom : ce seul tronçon). */
function sameTrack(all: TrackLine[], t: TrackLine): TrackLine[] {
  return t.name ? all.filter((o) => o.kind === t.kind && o.name === t.name && o.detail === t.detail) : [t];
}

/** Haut d'une piste (bout le plus élevé, à défaut le premier point) ou gare du bas d'une remontée. */
function trackFocus(tracks: TrackLine[]): [number, number] {
  const longest = tracks.reduce((a, b) => (b.length > a.length ? b : a));
  const c = longest.coordinates;
  return (longest.kind === 'lift' ? c[0] : c[Math.floor(c.length / 2)]) as [number, number];
}

function poiElement(poi: DomainPoi, onClick: () => void): HTMLElement {
  const cat = CATEGORY.get(poi.category)!;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'three-poi';
  el.style.background = cat.color;
  el.textContent = cat.emoji;
  el.title = poi.name || cat.label;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

export default function ThreeViewer({ domain }: { domain: SkiDomainConfig }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<SceneHandle | null>(null);
  const [data, setData] = useState<DomainData | null>(null);
  const [progress, setProgress] = useState<string | null>('Pistes et lieux');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [isWinter, setWinter] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>('explore');
  const [query, setQuery] = useState('');
  const [enabledPois, setEnabledPois] = useState<Set<DomainPoiCategoryId>>(() => new Set(DOMAIN_POI_CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id)));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [here, setHere] = useState<Here | null>(null);
  const [geoStatus, setGeoStatus] = useState<'off' | 'searching' | 'on' | 'denied'>('off');
  const [demo, setDemo] = useState(false);
  const live = useLiveConditions(domain.slug, !!domain.live, demo);
  const openings = live.data?.openings ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Position GPS utilisable comme départ : reçue, et dans le domaine.
  const gpsStart = useMemo(() => {
    if (geoStatus !== 'on' || !here || !data) return null;
    const near = nearestLine(here.lng, here.lat, data.tracks.pistes, false);
    return near && near.distance <= OFF_DOMAIN_M ? here : null;
  }, [geoStatus, here, data]);
  const routing = useRouting({
    handle,
    data,
    domain,
    gpsStart,
    live: live.data,
    setHere,
    setGeoStatus,
    requestGps: () => setGeoStatus('searching'),
    onNotice: setNotice,
  });
  const routingRef = useRef(routing);
  useEffect(() => {
    routingRef.current = routing;
  });

  // ---- Chargement : données, puis scène -------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const params = new URLSearchParams(window.location.search);
    let disposed = false;
    let scene: SceneHandle | null = null;
    loadDomainData(domain)
      .then((d) => {
        if (disposed) return null;
        setData(d);
        return createScene(
          container,
          domain,
          d,
          {
            forceWebGL: params.has('webgl'),
            segments: Math.min(512, Math.max(16, Number(params.get('maillage')) || 128)),
            antialias: params.has('aa'),
          },
          (label) => !disposed && setProgress(label || null),
          (s) => !disposed && setStats(s),
        );
      })
      .then((h) => {
        if (!h) return;
        if (disposed) h.dispose();
        else setHandle((scene = h));
      })
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      scene?.dispose();
      setHandle(null);
    };
  }, [domain]);

  // ---- Lieux sur la carte ----------------------------------------------------------------------
  const selectPoi = useRef<(poi: DomainPoi) => void>(() => undefined);
  useEffect(() => {
    if (!handle || !data) return;
    const labels: LabelHandle[] = data.pois
      .filter((p) => enabledPois.has(p.category))
      .map((p) => handle.addLabel(poiElement(p, () => selectPoi.current(p)), p.lng, p.lat, { lift: 25, maxDistance: POI_MAX_DISTANCE }));
    return () => labels.forEach((l) => l.remove());
  }, [handle, data, enabledPois]);

  // Villages : toujours affichés, un clic y amène la vue.
  useEffect(() => {
    if (!handle) return;
    const labels = domain.valleys.flatMap((valley) =>
      valley.villages.map((v) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'three-village';
        el.textContent = v.name;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          handle.flyTo({ lng: v.lng, lat: v.lat, distance: 3200, pitch: 60, bearing: valley.bearing });
        });
        return handle.addLabel(el, v.lng, v.lat, { lift: 60 });
      }),
    );
    return () => labels.forEach((l) => l.remove());
  }, [handle, domain.valleys]);

  // ---- Conditions en direct : tracés fermés estompés -------------------------------------------
  useEffect(() => {
    if (!handle || !data) return;
    const closed = (states: Record<string, LiveItemState> | undefined, list: TrackLine[]) =>
      new Set(list.filter((t) => (openings?.outOfSeason ? true : ['closed', 'out'].includes(states?.[String(t.osmId)]?.status ?? ''))).map((t) => t.osmId));
    if (!openings) handle.setClosedTracks(new Set(), new Set());
    else handle.setClosedTracks(closed(openings.pistes, data.tracks.pistes), closed(openings.lifts, data.tracks.lifts));
  }, [handle, data, openings]);

  // ---- Sélection : clic sur la carte, bulle qui suit la vue ------------------------------------
  useEffect(() => {
    if (!handle || !data) return;
    const all = [...data.tracks.pistes, ...data.tracks.lifts];
    handle.onPick((e) => {
      // Itinéraire : le toucher choisit le point de départ.
      if (routingRef.current.pickingRef.current) {
        routingRef.current.pickStart(e.lng, e.lat);
        return;
      }
      // Tolérance du clic : ~1,2 % de la distance à la caméra, 25 m au moins.
      const near = nearestLine(e.lng, e.lat, all, false);
      if (near && near.distance < Math.max(25, e.distance * 0.012)) {
        setSelection({ kind: 'track', tracks: sameTrack(all, near.item), at: [e.lng, e.lat] });
      } else setSelection(null);
    });
    selectPoi.current = (poi) => setSelection({ kind: 'poi', poi });
  }, [handle, data]);

  const anchor = useMemo<[number, number] | null>(
    () =>
      selection?.kind === 'track' ? selection.at : selection?.kind === 'poi' ? [selection.poi.lng, selection.poi.lat] : selection?.kind === 'here' && here ? [here.lng, here.lat] : null,
    [selection, here],
  );
  useEffect(() => {
    if (!handle) return;
    handle.setHighlight(selection?.kind === 'track' ? selection.tracks : null);
    if (!anchor) return;
    const place = () => {
      const el = cardRef.current;
      if (!el) return;
      const p = handle.project(anchor[0], anchor[1], 25);
      const parent = el.parentElement!;
      // Point hors de l'écran (vue déplacée) : la bulle se cache jusqu'à son retour.
      const onScreen = !!p && p.x >= 0 && p.y >= 0 && p.x <= parent.clientWidth && p.y <= parent.clientHeight;
      el.style.visibility = onScreen ? '' : 'hidden';
      if (!p || !onScreen) return;
      // Au-dessus du point, ou dessous s'il n'y a pas la place ; jamais hors de l'écran.
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.min(parent.clientWidth - w - 8, Math.max(8, p.x - w / 2));
      const above = p.y - h - 14;
      const y = above >= 8 ? above : Math.min(parent.clientHeight - h - 8, p.y + 14);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    place();
    return handle.onFrame(place);
  }, [handle, selection, anchor]);

  // ---- Position GPS ------------------------------------------------------------------------
  const hereLabel = useRef<LabelHandle | null>(null);
  useEffect(() => {
    // Simulation : la fausse position remplace le GPS.
    if (geoStatus === 'off' || routing.simulating || !('geolocation' in navigator)) return;
    let first = true;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const h = { lng: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy };
        setHere(h);
        setGeoStatus('on');
        // Première position hors guidage : la vue s'y rend (pendant le guidage, la caméra suit déjà).
        if (first && !routingRef.current.navigating) {
          handle?.flyTo({ lng: h.lng, lat: h.lat, distance: 1600, pitch: 58 });
          setSelection({ kind: 'here' });
        }
        first = false;
      },
      (err) => setGeoStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'off'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [geoStatus === 'off', handle, routing.simulating]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!handle) return;
    if (!here) {
      hereLabel.current?.remove();
      hereLabel.current = null;
      return;
    }
    if (!hereLabel.current) {
      const el = document.createElement('div');
      el.className = 'three-here';
      hereLabel.current = handle.addLabel(el, here.lng, here.lat, { lift: 4 });
    } else hereLabel.current.setLngLat(here.lng, here.lat);
  }, [handle, here]);
  useEffect(() => () => hereLabel.current?.remove(), []);

  // ---- Recherche --------------------------------------------------------------------------
  const searchIndex = useMemo<SearchEntry[]>(() => {
    if (!data) return [];
    const entries: SearchEntry[] = data.pois.map((p) => ({ id: p.id, name: p.name, sub: p.kind, emoji: CATEGORY.get(p.category)!.emoji, lng: p.lng, lat: p.lat, poi: p }));
    const seen = new Set<string>();
    for (const t of [...data.tracks.lifts, ...data.tracks.pistes]) {
      const key = `${t.kind}|${t.name}|${t.detail}`;
      if (!t.name || seen.has(key)) continue;
      seen.add(key);
      const tracks = sameTrack(t.kind === 'lift' ? data.tracks.lifts : data.tracks.pistes, t);
      const [lng, lat] = trackFocus(tracks);
      entries.push(
        t.kind === 'lift'
          ? { id: key, name: t.name, sub: LIFT_LABELS[t.detail] ?? 'Remontée', emoji: '🚡', lng, lat, tracks }
          : { id: key, name: t.name, sub: DIFFICULTY_SINGULAR[t.detail as PisteDifficulty] ?? 'Piste', color: trackColor(t), lng, lat, tracks },
      );
    }
    for (const valley of domain.valleys) {
      for (const v of valley.villages) {
        entries.push({ id: `village/${v.name}`, name: v.name, sub: `${valley.name} · ${v.altitude.toLocaleString('fr-FR')} m`, emoji: '🏔️', lng: v.lng, lat: v.lat, bearing: valley.bearing });
      }
    }
    return entries;
  }, [data, domain.valleys]);

  const results = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return [];
    return searchIndex.filter((e) => normalize(`${e.name} ${e.sub}`).includes(q)).slice(0, 40);
  }, [query, searchIndex]);

  const choose = (e: SearchEntry) => {
    if (!handle) return;
    setRotating(false);
    handle.setRotate(false);
    if (!isWide()) setPanelOpen(false);
    if (e.poi) {
      setEnabledPois((prev) => (prev.has(e.poi!.category) ? prev : new Set(prev).add(e.poi!.category)));
      handle.flyTo({ lng: e.lng, lat: e.lat, distance: 1400, pitch: 60 });
      setSelection({ kind: 'poi', poi: e.poi });
    } else if (e.tracks) {
      handle.flyTo({ lng: e.lng, lat: e.lat, distance: 2600, pitch: 58 });
      setSelection({ kind: 'track', tracks: e.tracks, at: [e.lng, e.lat] });
    } else {
      handle.flyTo({ lng: e.lng, lat: e.lat, distance: 3200, pitch: 60, bearing: e.bearing });
      setSelection(null);
    }
  };

  // ---- Fiches ------------------------------------------------------------------------------
  /** Haut d'une piste : le bout le plus élevé de ses tronçons, à défaut son premier point. */
  const pisteTop = (tracks: TrackLine[]): [number, number] => {
    let best = -Infinity;
    let top = tracks[0].coordinates[0] as [number, number];
    for (const t of tracks) {
      for (const c of [t.coordinates[0], t.coordinates[t.coordinates.length - 1]]) {
        const z = handle?.elevation(c[0], c[1]) ?? null;
        if (z !== null && z > best) {
          best = z;
          top = c as [number, number];
        }
      }
    }
    return top;
  };
  const seasonal = (st: LiveItemState | undefined): LiveItemState | undefined =>
    openings?.outOfSeason && st?.status === 'closed' ? { ...st, status: 'out', label: 'Hors saison', message: undefined } : st;
  const close = () => setSelection(null);

  let card: React.ReactNode = null;
  if (selection?.kind === 'track') {
    const t = selection.tracks[0];
    const length = selection.tracks.reduce((s, x) => s + x.length, 0);
    const states = t.kind === 'piste' ? openings?.pistes : openings?.lifts;
    const [lng, lat] = trackFocus(selection.tracks);
    card = (
      <TrackCard
        kind={t.kind}
        name={t.name || (t.kind === 'piste' ? 'Liaison' : (LIFT_LABELS[t.detail] ?? 'Remontée'))}
        typeLabel={t.kind === 'piste' ? (DIFFICULTY_SINGULAR[t.detail as PisteDifficulty] ?? 'Piste') : (LIFT_LABELS[t.detail] ?? 'Remontée')}
        color={trackColor(t)}
        length={length}
        state={seasonal(states?.[String(t.osmId)])}
        outOfSeason={!!openings?.outOfSeason}
        liveAvailable={!!live.data && !live.failed}
        demo={demo}
        goLabel={t.kind === 'piste' ? 'Aller en haut de la piste' : 'Aller à la gare du bas'}
        onGo={() => {
          close();
          if (!isWide()) setPanelOpen(false);
          const [glng, glat] = t.kind === 'piste' ? pisteTop(selection.tracks) : [lng, lat];
          routing.goTo({ kind: 'place', place: { id: `${t.kind}/${t.name}/${t.osmId}`, name: t.name || 'Destination', lng: glng, lat: glat } });
        }}
        onClose={close}
      />
    );
  } else if (selection?.kind === 'poi') {
    const p = selection.poi;
    const cat = CATEGORY.get(p.category)!;
    card = (
      <PlaceCard
        name={p.name || cat.label}
        kind={p.name === p.kind ? cat.label : p.kind}
        color={cat.color}
        icon={POI_ICONS[p.category]}
        openingHours={p.openingHours}
        phone={p.phone}
        website={p.website}
        onGo={() => {
          close();
          if (!isWide()) setPanelOpen(false);
          routing.goTo({ kind: 'poi', poi: p });
        }}
        onClose={close}
      />
    );
  } else if (selection?.kind === 'here' && here && data) {
    const nearPiste = nearestLine(here.lng, here.lat, data.tracks.pistes);
    const nearLift = nearestLine(here.lng, here.lat, data.tracks.lifts);
    const off = nearPiste && nearPiste.distance > OFF_DOMAIN_M;
    card = (
      <div className="relative w-[260px] p-4 text-sm">
        <button type="button" onClick={close} aria-label="Fermer" className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-foreground/45 hover:bg-winter-50">
          <X className="h-4 w-4" />
        </button>
        <p className="font-semibold text-foreground">Vous êtes ici</p>
        <p className="mt-0.5 text-xs text-foreground/55">Précision ± {Math.round(here.accuracy)} m</p>
        {off ? (
          <p className="mt-2 text-foreground/70">À {formatDistance(nearPiste!.distance)} du domaine.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-foreground/75">
            {nearPiste && (
              <li>
                Piste : <b>{nearPiste.item.name}</b> ({formatDistance(nearPiste.distance)})
              </li>
            )}
            {nearLift && (
              <li>
                Remontée : <b>{nearLift.item.name}</b> ({formatDistance(nearLift.distance)})
              </li>
            )}
          </ul>
        )}
      </div>
    );
  }

  // ---- Affichage ---------------------------------------------------------------------------
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    if (data) for (const p of data.tracks.pistes) if (p.name) m.set(p.detail, (m.get(p.detail) ?? 0) + 1);
    return m;
  }, [data]);
  const poiCounts = useMemo(() => {
    const m = new Map<DomainPoiCategoryId, number>();
    for (const p of data?.pois ?? []) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [data]);
  const roundButton = 'inline-flex h-10 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-semibold text-foreground shadow-lg backdrop-blur hover:bg-white';

  return (
    <div className="fixed inset-0 overflow-hidden bg-winter-900">
      {/* Contexte d'empilement propre : les étiquettes (z-index posés par CSS2DRenderer) restent sous le panneau. */}
      <div ref={containerRef} className="absolute inset-0 isolate" />

      {/* Bulle de la sélection, ancrée sur la carte. */}
      {card && (
        <div ref={cardRef} className="pointer-events-auto absolute left-0 top-0 z-30 rounded-[20px] bg-card shadow-[0_12px_32px_rgb(28_46_64/0.22)]" style={{ visibility: 'hidden' }}>
          {card}
        </div>
      )}

      {/* Boutons de la carte. */}
      <div className="absolute right-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap justify-end gap-2">
        <button type="button" className={roundButton} onClick={() => (geoStatus === 'off' || geoStatus === 'denied' ? setGeoStatus('searching') : here && handle?.flyTo({ lng: here.lng, lat: here.lat, distance: 1600, pitch: 58 }))}>
          <LocateFixed className="h-4 w-4" /> {geoStatus === 'searching' ? 'Recherche…' : geoStatus === 'denied' ? 'Position refusée' : 'Ma position'}
        </button>
        {!routing.routeOpen && (
          <button
            type="button"
            className={roundButton}
            onClick={() => {
              if (!isWide()) setPanelOpen(false);
              setSelection(null);
              routing.openRoute();
            }}
          >
            <Navigation className="h-4 w-4" /> Itinéraire
          </button>
        )}
        <button type="button" className={roundButton} onClick={() => handle?.overview()}>
          <Maximize2 className="h-4 w-4" /> Vue d&apos;ensemble
        </button>
        <button
          type="button"
          className={roundButton}
          onClick={() => {
            handle?.setRotate(!rotating);
            setRotating(!rotating);
          }}
        >
          <RotateCw className="h-4 w-4" /> {rotating ? 'Arrêter' : 'Rotation'}
        </button>
        <button
          type="button"
          className={roundButton}
          onClick={() => {
            handle?.setWinter(!isWinter);
            setWinter(!isWinter);
          }}
        >
          <Snowflake className="h-4 w-4" /> {isWinter ? 'Été' : 'Hiver'}
        </button>
        {!panelOpen && (
          <button type="button" className={roundButton} onClick={() => setPanelOpen(true)}>
            <Search className="h-4 w-4" /> Rechercher
          </button>
        )}
      </div>

      {/* Compteur d'images (comparaison avec la carte MapLibre). */}
      <div className="absolute bottom-3 right-3 z-10 rounded-xl bg-background/85 px-3 py-2 text-[11px] leading-snug text-foreground/70 shadow backdrop-blur">
        {stats ? (
          <>
            <b className="text-foreground">{stats.backend}</b> · {stats.fps ? `${stats.fps} i/s · ${Math.round(stats.slowShare * 100)} % sous 40` : 'au repos'}
            <br />
            {stats.trees.toLocaleString('fr-FR')} sapins · {Math.round(stats.triangles / 1000).toLocaleString('fr-FR')} k triangles · {stats.drawCalls} appels
          </>
        ) : (
          'Démarrage du moteur…'
        )}
      </div>

      {routing.navigating && (
        <NavigationBar route={routing.shownRoute} gpsPending={!gpsStart} simulated={routing.simulating} topClass="top-16" onStop={routing.stopNavigation} />
      )}

      {routing.routeOpen && !routing.navigating && (
        <div className={`pointer-events-none absolute bottom-3 z-20 flex justify-center px-3 sm:bottom-16 ${panelOpen ? 'left-0 right-0 sm:left-[372px]' : 'left-0 right-0'}`}>
          <RouteCard
            hasStart={routing.hasStart}
            startLabel={routing.pickedStart ? 'Point choisi sur la carte' : 'Ma position'}
            gpsAvailable={!!gpsStart}
            picking={routing.picking}
            onPickStart={() => routing.setPicking(true)}
            onUseGps={routing.useGps}
            goal={routing.routeGoal}
            onGoal={routing.setRouteGoal}
            villages={domain.valleys.flatMap((v) => v.villages.map((x) => x.name))}
            level={routing.routeLevel}
            onLevel={routing.setRouteLevel}
            status={routing.routeStatus}
            result={routing.route}
            closedCount={routing.closedCount}
            onStart={() => {
              setPanelOpen(false);
              routing.startNavigation();
            }}
            onSimulate={() => {
              setPanelOpen(false);
              setSelection(null);
              routing.startSimulation();
            }}
            onClose={routing.closeRoute}
          />
        </div>
      )}

      {notice && (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex justify-center px-3">
          <p className="rounded-full bg-winter-900/90 px-4 py-2 text-sm font-semibold text-white shadow-lg">{notice}</p>
        </div>
      )}

      {panelOpen && !routing.navigating && (
        <aside className="absolute inset-x-3 bottom-3 z-20 flex max-h-[62vh] flex-col overflow-hidden rounded-[28px] border border-white/70 bg-background/95 shadow-2xl backdrop-blur-md sm:bottom-auto sm:right-auto sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[360px]">
          <div className="border-b border-winter-100 bg-card/80 px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              <a href={`/carte/${domain.slug}`} className="text-xs font-semibold text-primary hover:underline">
                Carte MapLibre
              </a>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label="Fermer le panneau" className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/50 hover:bg-winter-50">
                <X className="h-4 w-4" />
              </button>
            </div>
            <h1 className="mt-1 font-display text-2xl leading-tight text-foreground">
              {domain.name} <span className="italic text-accent">Three.js</span>
            </h1>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Restaurant, remontée, piste, station…"
                className="h-11 w-full rounded-2xl border border-winter-100 bg-white pl-9 pr-9 text-sm outline-none focus:border-primary/50"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Effacer" className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-foreground/45 hover:bg-winter-50">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {!query && (
              <div className="mt-3 grid grid-cols-2 gap-1 rounded-2xl bg-winter-50 p-1 text-sm font-semibold">
                {(
                  [
                    ['explore', 'Explorer'],
                    ['conditions', 'Conditions'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-xl py-2 ${tab === id ? 'bg-white text-foreground shadow-sm' : 'text-foreground/55'}`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {query ? (
              results.length ? (
                <ul className="space-y-1">
                  {results.map((e) => (
                    <li key={e.id}>
                      <button type="button" onClick={() => choose(e)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-winter-50">
                        {e.color ? <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: e.color }} /> : <span className="w-4 shrink-0 text-center">{e.emoji}</span>}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground">{e.name || e.sub}</span>
                          <span className="block truncate text-xs text-foreground/55">{e.sub}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-foreground/55">Aucun résultat.</p>
              )
            ) : tab === 'conditions' ? (
              <LivePanel state={live} demo={demo} onToggleDemo={() => setDemo((d) => !d)} />
            ) : (
              <div className="space-y-5">
                <section>
                  <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-foreground/45">Pistes</h2>
                  <div className="grid grid-cols-2 gap-2">
                    {DIFFICULTIES.map((d) => (
                      <div key={d} className="flex items-center justify-between rounded-xl border border-winter-100 bg-white px-3 py-2 text-sm">
                        <span className="flex items-center gap-2 font-semibold">
                          <span className="h-3 w-3 rounded-full" style={{ background: PISTE_COLORS[d] }} /> {DIFFICULTY_LABELS[d]}
                        </span>
                        <span className="text-foreground/50">{counts.get(d) ?? 0}</span>
                      </div>
                    ))}
                  </div>
                </section>
                <section>
                  <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-foreground/45">Lieux sur la carte</h2>
                  <ul className="space-y-1">
                    {DOMAIN_POI_CATEGORIES.filter((c) => poiCounts.get(c.id)).map((c) => {
                      const on = enabledPois.has(c.id);
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() =>
                              setEnabledPois((prev) => {
                                const next = new Set(prev);
                                if (on) next.delete(c.id);
                                else next.add(c.id);
                                return next;
                              })
                            }
                            className="flex w-full items-center justify-between rounded-xl px-2 py-1.5 text-sm hover:bg-winter-50"
                          >
                            <span className="flex items-center gap-2.5">
                              <span className="flex h-7 w-7 items-center justify-center rounded-full text-sm" style={{ background: on ? c.color : '#e9ecef' }}>
                                {c.emoji}
                              </span>
                              <span className={on ? 'font-semibold text-foreground' : 'text-foreground/55'}>{c.label}</span>
                            </span>
                            <span className="text-xs text-foreground/45">{poiCounts.get(c.id)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
                <p className="text-xs leading-relaxed text-foreground/50">
                  Version Three.js en essai : cliquez une piste, une remontée ou un lieu pour sa fiche et l&apos;itinéraire pour y aller.
                </p>
              </div>
            )}
          </div>
        </aside>
      )}

      {(progress !== null || error) && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-winter-900/90 text-white">
          {error ? (
            <>
              <p className="font-display text-2xl">Carte 3D indisponible</p>
              <p className="mt-2 max-w-md text-center text-sm text-white/70">{error}</p>
            </>
          ) : (
            <>
              <Loader2 className="mb-4 h-8 w-8 animate-spin text-white/80" />
              <p className="font-display text-2xl">{domain.name}</p>
              <p className="mt-1 text-sm text-white/60">{progress}…</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
