'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Layers, Loader2, LocateFixed, Maximize2, Menu, Navigation, RotateCw, Search, Snowflake, X } from 'lucide-react';
import type { PisteDifficulty } from '@/lib/apis/overpass';
import { DOMAIN_POI_CATEGORIES, type DomainPoi, type DomainPoiCategoryId } from '@/lib/domainPois';
import { DIFFICULTY_SINGULAR, LIFT_LABELS, type SkiDomainConfig } from '@/lib/skiDomains';
import type { LiveItemState } from '@/lib/live/types';
import LivePanel, { AvalancheRiskIcon, RISK_LABELS } from '@/components/domain/LivePanel';
import { PlaceCard, TrackCard } from '@/components/domain/MapCards';
import { formatDistance, nearestLine } from '@/components/domain/nearby';
import { POI_ICONS } from '@/components/domain/panelIcons';
import RouteCard, { NavigationBar } from '@/components/domain/RouteCard';
import { useLiveConditions } from '@/components/domain/useLiveConditions';
import { useMapGestures } from '@/components/domain/useMapGestures';
import { useKeyboardInset } from '@/components/domain/useKeyboardInset';
import { loadDomainData, type DomainData, type TrackLine } from './domainData';
import { trackColor } from './overlays';
import { createScene, type LabelHandle, type SceneHandle, type SceneStats } from './scene';
import { useRouting } from './useRouting';
import PlaceCarousel from './PlaceCarousel';

/**
 * Carte 3D du domaine en Three.js (WebGPU) : relief, pistes, remontées, sapins, lieux,
 * recherche, position GPS, conditions en direct, itinéraires et guidage (page /carte/…).
 */

const CATEGORY = new Map(DOMAIN_POI_CATEGORIES.map((c) => [c.id, c]));
const normalize = (v: string) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isWide = () => window.innerWidth >= 640;
/** Lieux masqués au-delà de cette distance de la caméra (m) : la vue d'ensemble reste lisible. */
const POI_MAX_DISTANCE = 9000;
/** Au-delà de cette distance des pistes, on est hors du domaine (m). */
const OFF_DOMAIN_M = 2000;
/** Tracés fermés plus courts : pas de croix (liaisons, bouts de piste), comme sur la carte MapLibre. */
const CLOSED_CROSS_MIN_LENGTH = 150;

/** Point au milieu (en longueur) d'un tracé. */
function midpoint(coords: number[][]): [number, number] {
  const seg = (i: number) => Math.hypot((coords[i][0] - coords[i - 1][0]) * Math.cos((coords[i][1] * Math.PI) / 180), coords[i][1] - coords[i - 1][1]);
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += seg(i);
  let left = total / 2;
  for (let i = 1; i < coords.length; i++) {
    const d = seg(i);
    if (d >= left && d > 0) {
      const t = left / d;
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
    }
    left -= d;
  }
  return coords[0] as [number, number];
}

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
  useMapGestures();
  // Clavier ouvert (recherche de destination) : seule la fiche d'itinéraire remonte.
  const keyboard = useKeyboardInset();
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<SceneHandle | null>(null);
  const [data, setData] = useState<DomainData | null>(null);
  const [progress, setProgress] = useState<string | null>('Pistes et lieux');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [isWinter, setWinter] = useState(true);
  const [rotating, setRotating] = useState(false);
  // Panneau (tiroir) fermé à l'ouverture : la carte d'abord, le menu au bouton ☰.
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('conditions');
  const [query, setQuery] = useState('');
  const [enabledPois, setEnabledPois] = useState<Set<DomainPoiCategoryId>>(() => new Set(DOMAIN_POI_CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id)));
  /** Type de lieu seul affiché (toucher dans Explorer), ou null : tous ceux par défaut. */
  const [solo, setSolo] = useState<DomainPoiCategoryId | null>(null);
  /** Fiches du type affiché seul, en bas de l'écran : lieu montré, et fiches ouvertes ou rangées. */
  const [placeIndex, setPlaceIndex] = useState(0);
  const [carouselOpen, setCarouselOpen] = useState(false);
  /** Point d'où les fiches sont classées (position GPS au moment du choix), sinon d'ouest en est. */
  const [soloOrigin, setSoloOrigin] = useState<{ lng: number; lat: number } | null>(null);
  /** Réglage « Lieux affichés sur la carte » ouvert (interrupteurs par type). */
  const [layersOpen, setLayersOpen] = useState(false);
  const defaultPois = () => new Set(DOMAIN_POI_CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id));
  /** Un seul type sur la carte : le panneau se replie, une étiquette rappelle le filtre. */
  const showOnly = (id: DomainPoiCategoryId) => {
    setSolo(id);
    setEnabledPois(new Set([id]));
    setPanelOpen(false);
    setSelection(null);
    setSoloOrigin(gpsStartRef.current);
    setPlaceIndex(0);
    setCarouselOpen(true);
  };
  /** Interrupteurs : plusieurs types à la fois ; on quitte l'affichage d'un seul type. */
  const showLayers = (next: Set<DomainPoiCategoryId>) => {
    setSolo(null);
    setCarouselOpen(false);
    setEnabledPois(next);
  };
  const showAll = () => {
    setSolo(null);
    setCarouselOpen(false);
    setEnabledPois(defaultPois());
  };
  const [selection, setSelection] = useState<Selection | null>(null);
  const [here, setHere] = useState<Here | null>(null);
  const [geoStatus, setGeoStatus] = useState<'off' | 'searching' | 'on' | 'denied'>('off');
  // Jour de pleine saison simulé : ?demo=saison dans l'adresse, ou le bouton de l'onglet Conditions
  // (comme sur la carte MapLibre). Gardé dans l'adresse : lien partageable, rechargement.
  const [demo, setDemo] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'saison');
  const toggleDemo = () => {
    const next = !demo;
    setDemo(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('demo', 'saison');
    else url.searchParams.delete('demo');
    window.history.replaceState(window.history.state, '', url);
  };
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
  const gpsStartRef = useRef(gpsStart);
  useEffect(() => {
    gpsStartRef.current = gpsStart;
  }, [gpsStart]);
  /** Distance (m) au domaine si la position en est loin (plus de 2 km des pistes), sinon null. */
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const offDomainMeters = (p: { lng: number; lat: number }): number | null => {
    const d = dataRef.current;
    if (!d) return null;
    const near = nearestLine(p.lng, p.lat, d.tracks.pistes, false);
    return near && near.distance > OFF_DOMAIN_M ? near.distance : null;
  };
  /** Demande la position (sans géolocalisation dans le navigateur : message). */
  const locate = () => {
    if (!('geolocation' in navigator)) {
      setNotice('Position non trouvée.');
      return;
    }
    setGeoStatus('searching');
  };
  /** Vue sur la position, sauf hors du domaine (message, la carte reste où elle est). */
  const goToHere = (p: { lng: number; lat: number }) => {
    const away = offDomainMeters(p);
    if (away !== null) setNotice('Position non trouvée sur le domaine.');
    else handle?.flyTo({ lng: p.lng, lat: p.lat, distance: 1600, pitch: 58 });
  };

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

  // Bâtiments 3D des lieux : mêmes catégories que les pastilles.
  useEffect(() => {
    handle?.setPlaceCategories(enabledPois);
  }, [handle, enabledPois]);

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

  // Croix rouge au milieu de chaque piste ou remontée fermée (pas hors saison : tout le serait).
  useEffect(() => {
    // Un seul type de lieu affiché (restaurants, pique-nique…) : pas de croix, la carte reste lisible.
    if (!handle || !data || !openings || openings.outOfSeason || solo) return;
    const all = [...data.tracks.pistes, ...data.tracks.lifts];
    const labels = all
      .filter((t) => t.length >= CLOSED_CROSS_MIN_LENGTH && (t.kind === 'piste' ? openings.pistes : openings.lifts)[String(t.osmId)]?.status === 'closed')
      .map((t) => {
        const [lng, lat] = midpoint(t.coordinates);
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'three-closed';
        el.title = `${t.name || (t.kind === 'piste' ? 'Piste' : 'Remontée')} : fermée`;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          setSelection({ kind: 'track', tracks: sameTrack(all, t), at: [lng, lat] });
        });
        return handle.addLabel(el, lng, lat, { lift: 8 });
      });
    return () => labels.forEach((l) => l.remove());
  }, [handle, data, openings, solo]);

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
        // Première position hors guidage : la vue s'y rend (pendant le guidage, la caméra suit déjà) ;
        // hors du domaine, un message, et la carte reste où elle est.
        if (first && !routingRef.current.navigating) {
          const away = offDomainMeters(h);
          if (away !== null) setNotice('Position non trouvée sur le domaine.');
          else {
            handle?.flyTo({ lng: h.lng, lat: h.lat, distance: 1600, pitch: 58 });
            setSelection({ kind: 'here' });
          }
        }
        first = false;
      },
      (err) => {
        // Pas d'accès à la position : message, la carte ne bouge pas.
        setNotice(
          err.code === err.PERMISSION_DENIED ? 'Position non trouvée : localisation non autorisée.' : 'Position non trouvée.',
        );
        setGeoStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'off');
      },
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
      // Le point glisse d'une position GPS à la suivante (pas de saut toutes les secondes).
      hereLabel.current = handle.addLabel(el, here.lng, here.lat, { lift: 4, smooth: true });
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

  /** Listes déroulantes de la fiche d'itinéraire : remontées, pistes, restaurants, stations (par nom). */
  const destinationGroups = useMemo(() => {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');
    const pick = (f: (e: SearchEntry) => boolean) => searchIndex.filter(f).filter((e) => e.name).map((e) => ({ id: e.id, name: e.name })).sort(byName);
    return [
      { label: 'Remontée', emoji: '🚡', options: pick((e) => !!e.tracks && e.tracks[0].kind === 'lift') },
      { label: 'Piste', emoji: '⛷️', options: pick((e) => !!e.tracks && e.tracks[0].kind === 'piste') },
      { label: 'Restaurant', emoji: '🍽️', options: pick((e) => e.poi?.category === 'restaurant' || e.poi?.category === 'hut') },
      { label: 'Station', emoji: '🏔️', options: pick((e) => !e.poi && !e.tracks) },
    ];
  }, [searchIndex]);

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
        demo={false}
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
  // ---- Fiches du type affiché seul ------------------------------------------------------------
  const soloPlaces = useMemo(() => {
    if (!solo || !data) return [];
    const list = data.pois.filter((p) => p.category === solo);
    const o = soloOrigin;
    // Les plus proches d'abord avec le GPS ; sinon d'ouest en est, comme on parcourt la carte.
    return o ? list.sort((a, b) => Math.hypot(a.lng - o.lng, a.lat - o.lat) - Math.hypot(b.lng - o.lng, b.lat - o.lat)) : list.sort((a, b) => a.lng - b.lng);
  }, [solo, data, soloOrigin]);
  const carouselShown = !!solo && carouselOpen && soloPlaces.length > 0 && !panelOpen && !routing.routeOpen && !routing.navigating;
  // La carte va sur le lieu de la fiche affichée.
  const shownPlace = carouselShown ? soloPlaces[Math.min(placeIndex, soloPlaces.length - 1)] : null;
  useEffect(() => {
    if (shownPlace) handle?.flyTo({ lng: shownPlace.lng, lat: shownPlace.lat, distance: 1300, pitch: 58, duration: 900 });
  }, [handle, shownPlace]);
  // Pastille touchée : en affichage d'un seul type, elle montre sa fiche en bas ; sinon, la bulle.
  useEffect(() => {
    selectPoi.current = (poi) => {
      const i = solo === poi.category ? soloPlaces.findIndex((p) => p.id === poi.id) : -1;
      if (i >= 0) {
        setSelection(null);
        setPlaceIndex(i);
        setCarouselOpen(true);
      } else setSelection({ kind: 'poi', poi });
    };
  });

  const poiCounts = useMemo(() => {
    const m = new Map<DomainPoiCategoryId, number>();
    for (const p of data?.pois ?? []) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [data]);
  /** Types présents sur ce domaine, dans l'ordre du panneau. */
  const shownCategories = DOMAIN_POI_CATEGORIES.filter((c) => poiCounts.get(c.id));

  return (
    <div className="fixed inset-0 overflow-hidden bg-winter-900">
      {/* Contexte d'empilement propre : les étiquettes (z-index posés par CSS2DRenderer) restent sous le panneau. */}
      {/* Hauteur « grand écran » (100lvh), indépendante du clavier et des barres du navigateur : la
          carte n'est pas redimensionnée (ni redessinée en entier) quand le clavier s'ouvre. */}
      <div ref={containerRef} className="absolute inset-x-0 top-0 isolate h-lvh" />

      {/* Bulle de la sélection, ancrée sur la carte. */}
      {card && (
        <div ref={cardRef} className="pointer-events-auto absolute left-0 top-0 z-30 rounded-[20px] bg-card shadow-[0_12px_32px_rgb(28_46_64/0.22)]" style={{ visibility: 'hidden' }}>
          {card}
        </div>
      )}

      {/* Type de lieu seul affiché : rappel en haut de la carte, ✕ pour tout revoir. */}
      {solo && !panelOpen && !routing.navigating && (() => {
        const c = CATEGORY.get(solo)!;
        return (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/95 py-1 pl-1 pr-1.5 text-sm font-semibold text-foreground shadow-lg backdrop-blur">
            <button type="button" onClick={() => setPanelOpen(true)} className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: c.color }}>
                {c.emoji}
              </span>
              {c.label}
              <span className="text-xs font-normal text-foreground/50">{poiCounts.get(solo) ?? 0}</span>
            </button>
            <button type="button" onClick={showAll} aria-label="Afficher tous les lieux" className="flex h-7 w-7 items-center justify-center rounded-full text-foreground/50 hover:bg-winter-50">
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })()}

      {/* Menu (ouvre le tiroir) et risque d'avalanche, en haut de la carte. */}
      {!panelOpen && !routing.navigating && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          aria-label="Ouvrir le menu"
          className="absolute left-3 top-3 z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/95 text-foreground shadow-lg backdrop-blur hover:bg-white"
        >
          <Menu className="h-6 w-6" />
        </button>
      )}
      {/* Masqué quand un seul type de lieu est affiché : son étiquette prend le haut de l'écran. */}
      {live.data?.avalanche?.risk && !routing.navigating && !solo ? (
        // Carré : pictogramme du risque seul ; ouvre le bulletin complet (Météo-France),
        // qui explique le risque (pentes, altitudes, neige).
        <a
          href={live.data.avalanche.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Risque d'avalanche ${live.data.avalanche.risk}/5 (${RISK_LABELS[live.data.avalanche.risk]}) : voir le bulletin Météo-France`}
          className="absolute right-3 top-3 z-10 block drop-shadow-lg transition-transform hover:scale-105"
        >
          {/* Le pictogramme seul, sans fond autour. */}
          <AvalancheRiskIcon risk={live.data.avalanche.risk} className="h-12 w-12" />
        </a>
      ) : null}

      {/* Ma position, en bas à droite comme sur Google Maps / Plans (hors guidage). */}
      {!routing.navigating && !carouselShown && (
        <button
          type="button"
          aria-label="Ma position"
          title={geoStatus === 'denied' ? 'Position refusée' : 'Ma position'}
          onClick={() => {
            if (geoStatus === 'off' || geoStatus === 'denied') locate();
            else if (here) goToHere(here);
          }}
          className={`absolute bottom-[4.5rem] right-3 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-white/95 shadow-lg backdrop-blur hover:bg-white ${
            geoStatus === 'on' ? 'text-primary' : geoStatus === 'denied' ? 'text-red-500' : 'text-foreground/70'
          }`}
        >
          <LocateFixed className={`h-6 w-6 ${geoStatus === 'searching' ? 'animate-pulse' : ''}`} />
        </button>
      )}

      {/* Itinéraire, en bas au centre (hors guidage et hors fiche d'itinéraire ouverte). */}
      {/* Fiches du type affiché seul (restaurants…), à faire défiler ; rangées : un bouton les rouvre. */}
      {carouselShown && solo && (
        <PlaceCarousel
          places={soloPlaces}
          index={Math.min(placeIndex, soloPlaces.length - 1)}
          onIndex={setPlaceIndex}
          color={CATEGORY.get(solo)!.color}
          icon={POI_ICONS[solo]}
          label={CATEGORY.get(solo)!.label}
          onGo={(poi) => {
            setCarouselOpen(false);
            routing.goTo({ kind: 'poi', poi });
          }}
          onHide={() => setCarouselOpen(false)}
        />
      )}
      {solo && !carouselOpen && soloPlaces.length > 0 && !panelOpen && !routing.routeOpen && !routing.navigating && (
        <button
          type="button"
          onClick={() => {
            setSelection(null);
            setCarouselOpen(true);
          }}
          className="absolute bottom-[4.5rem] left-1/2 z-10 inline-flex h-10 -translate-x-1/2 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-semibold text-foreground shadow-lg backdrop-blur hover:bg-white"
        >
          <ChevronUp className="h-4 w-4" aria-hidden /> {CATEGORY.get(solo)!.label} ({soloPlaces.length})
        </button>
      )}

      {!routing.navigating && !routing.routeOpen && !carouselShown && (
        <button
          type="button"
          onClick={() => {
            setPanelOpen(false);
            setSelection(null);
            routing.openRoute();
          }}
          className="absolute bottom-4 left-1/2 z-10 inline-flex h-12 -translate-x-1/2 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-lg hover:bg-winter-700"
        >
          <Navigation className="h-5 w-5" /> Itinéraire
        </button>
      )}

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
        <NavigationBar route={routing.shownRoute} gpsPending={!gpsStart} simulated={false} topClass="top-0 pt-[max(0.5rem,env(safe-area-inset-top))]" onStop={routing.stopNavigation} />
      )}

      {routing.routeOpen && !routing.navigating && (
        <div
          className={`pointer-events-none absolute bottom-3 z-20 flex justify-center px-3 sm:bottom-16 ${panelOpen ? 'left-0 right-0 sm:left-[372px]' : 'left-0 right-0'}`}
          style={keyboard.inset > 40 ? { bottom: keyboard.inset + 8 } : undefined}
        >
          <RouteCard
            maxHeight={keyboard.visibleHeight ? keyboard.visibleHeight - 24 : undefined}
            hasStart={routing.hasStart}
            startLabel={
              routing.pickedStart
                ? 'Point choisi sur la carte'
                : gpsStart
                  ? 'Ma position'
                  : geoStatus === 'searching'
                    ? 'Recherche de votre position…'
                    : 'Position non trouvée'
            }
            gpsAvailable={!!gpsStart}
            picking={routing.picking}
            onPickStart={() => routing.setPicking(true)}
            onCancelPick={() => routing.setPicking(false)}
            onUseGps={() => {
              routing.useGps();
              // Position pas encore connue : on la demande (message si introuvable).
              if (!gpsStart) locate();
            }}
            goal={routing.routeGoal}
            onGoal={routing.setRouteGoal}
            onClearGoal={() => routing.setRouteGoal(null)}
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
            simulateLabel="Aperçu du trajet en accéléré"
            destinationSearch={{
              groups: destinationGroups,
              search: (q) => {
                const n = normalize(q.trim());
                return searchIndex.filter((e) => normalize(`${e.name} ${e.sub}`).includes(n));
              },
              onPick: (id) => {
                const e = searchIndex.find((x) => x.id === id);
                if (!e) return;
                if (e.poi) routing.setRouteGoal({ kind: 'poi', poi: e.poi });
                else if (e.tracks) {
                  // Piste : son haut ; remontée : sa gare du bas.
                  const [lng, lat] = e.tracks[0].kind === 'piste' ? pisteTop(e.tracks) : [e.lng, e.lat];
                  routing.setRouteGoal({ kind: 'place', place: { id: e.id, name: e.name, lng, lat } });
                } else routing.setRouteGoal({ kind: 'village', name: e.name });
              },
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

      {/* Voile derrière le tiroir (téléphone) : un toucher le referme. */}
      {panelOpen && !routing.navigating && (
        <button type="button" aria-label="Fermer le menu" onClick={() => setPanelOpen(false)} className="absolute inset-0 z-20 bg-winter-900/25 sm:hidden" />
      )}
      {!routing.navigating && (
        <aside
          aria-hidden={!panelOpen}
          className={`absolute bottom-0 left-0 top-0 z-30 flex w-[min(88vw,360px)] flex-col overflow-hidden border-r border-white/70 bg-background/95 shadow-2xl backdrop-blur-md transition-transform duration-300 ease-out sm:bottom-3 sm:left-3 sm:top-3 sm:rounded-[28px] sm:border ${
            panelOpen ? 'translate-x-0' : 'pointer-events-none -translate-x-[calc(100%+1rem)]'
          }`}
        >
          <div className="border-b border-winter-100 bg-card/80 px-4 pb-3 pt-3">
            <div className="flex items-center justify-between gap-2">
              <h1 className="font-display text-2xl leading-tight text-foreground">{domain.name}</h1>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label="Fermer le panneau" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/50 hover:bg-winter-50">
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Actions de la carte (autrefois en boutons au-dessus de la carte). */}
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {(
                [
                  {
                    icon: Maximize2,
                    label: 'Vue d’ensemble',
                    run: () => {
                      handle?.overview();
                      if (!isWide()) setPanelOpen(false);
                    },
                  },
                  {
                    icon: RotateCw,
                    label: rotating ? 'Arrêter' : 'Rotation',
                    run: () => {
                      handle?.setRotate(!rotating);
                      setRotating(!rotating);
                      if (!isWide()) setPanelOpen(false);
                    },
                  },
                  {
                    icon: Snowflake,
                    label: isWinter ? 'Été' : 'Hiver',
                    run: () => {
                      handle?.setWinter(!isWinter);
                      setWinter(!isWinter);
                    },
                  },
                ] as const
              ).map(({ icon: Icon, label, run }) => (
                <button
                  key={label}
                  type="button"
                  onClick={run}
                  className="flex flex-col items-center gap-1 rounded-2xl border border-winter-100 bg-white px-1 py-2 text-[11px] font-semibold text-foreground/80 hover:border-primary/40"
                >
                  <Icon className="h-4 w-4 text-primary" /> {label}
                </button>
              ))}
            </div>
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
                    ['conditions', 'Conditions'],
                    ['explore', 'Explorer'],
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
              <LivePanel state={live} demo={demo} onToggleDemo={toggleDemo} weather={false} demoNotice={false} />
            ) : (
              <div className="space-y-5">
                {/* Explorer : un type de lieu → la carte ne montre que lui, avec ses fiches en bas. */}
                <section>
                  <h2 className="mb-2.5 text-xs font-bold uppercase tracking-[0.14em] text-foreground/45">Explorer les lieux</h2>
                  <ul className="grid grid-cols-2 gap-2">
                    {DOMAIN_POI_CATEGORIES.filter((c) => poiCounts.get(c.id)).map((c) => {
                      const Icon = POI_ICONS[c.id];
                      const n = poiCounts.get(c.id) ?? 0;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => showOnly(c.id)}
                            aria-pressed={solo === c.id}
                            className={`flex h-full w-full flex-col items-start gap-2 rounded-2xl border bg-card p-3 text-left transition hover:border-primary/40 hover:shadow-sm active:scale-[0.98] ${
                              solo === c.id ? 'border-primary ring-2 ring-primary/20' : 'border-winter-100'
                            }`}
                          >
                            <span className="flex h-9 w-9 items-center justify-center rounded-full text-white" style={{ backgroundColor: c.color }}>
                              <Icon className="h-[18px] w-[18px]" aria-hidden />
                            </span>
                            <span className="text-[13px] font-semibold leading-snug text-foreground">{c.label}</span>
                            <span className="mt-auto text-xs text-foreground/50">
                              {n} {n > 1 ? 'lieux' : 'lieu'}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                {/* Réglage à part : quels types restent sur la carte en temps normal (interrupteurs). */}
                <section className="rounded-2xl border border-winter-100 bg-card">
                  <button
                    type="button"
                    onClick={() => setLayersOpen((o) => !o)}
                    aria-expanded={layersOpen}
                    className="flex w-full items-center gap-3 px-3.5 py-3 text-left"
                  >
                    <Layers className="h-5 w-5 shrink-0 text-winter-600" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">Lieux affichés sur la carte</span>
                      <span className="block text-xs text-foreground/50">
                        {solo ? `Seulement : ${CATEGORY.get(solo)!.label.toLowerCase()}` : `${shownCategories.filter((c) => enabledPois.has(c.id)).length} types sur ${shownCategories.length}`}
                      </span>
                    </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-foreground/40 transition ${layersOpen ? 'rotate-180' : ''}`} aria-hidden />
                  </button>
                  {layersOpen && (
                    <div className="border-t border-winter-100 px-3.5 pb-2 pt-1">
                      <div className="flex gap-3 py-1.5 text-xs font-semibold">
                        <button type="button" onClick={() => showLayers(new Set(shownCategories.map((c) => c.id)))} className="text-primary hover:underline">
                          Tout afficher
                        </button>
                        <button type="button" onClick={() => showLayers(new Set())} className="text-primary hover:underline">
                          Tout masquer
                        </button>
                      </div>
                      <ul>
                        {shownCategories.map((c) => {
                          const on = enabledPois.has(c.id);
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={on}
                                onClick={() => {
                                  const next = new Set(enabledPois);
                                  if (on) next.delete(c.id);
                                  else next.add(c.id);
                                  showLayers(next);
                                }}
                                className="flex min-h-11 w-full items-center gap-2.5 text-left text-sm"
                              >
                                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color, opacity: on ? 1 : 0.35 }} aria-hidden />
                                <span className={`min-w-0 flex-1 truncate ${on ? 'text-foreground' : 'text-foreground/50'}`}>{c.label}</span>
                                {/* Interrupteur. */}
                                <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-winter-200'}`} aria-hidden>
                                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </section>
                <p className="text-xs leading-relaxed text-foreground/50">
                  Touchez une piste, une remontée ou un lieu sur la carte pour voir sa fiche et l&apos;itinéraire pour y aller.
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
