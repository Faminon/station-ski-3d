'use client';

// Itinéraires à ski et guidage de la carte Three.js : même comportement que la carte MapLibre
// (Domain3DViewer.tsx), sur le même réseau (src/lib/skiRouting.ts).
//
// Départ : point choisi sur la carte, sinon position GPS. Calcul une fois hors guidage ;
// pendant le guidage, recalcul tous les ~30 m. Pistes et remontées fermées (conditions en
// direct) évitées, sauf hors saison. Simulation : une fausse position parcourt l'itinéraire.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveConditions, LiveItemState } from '@/lib/live/types';
import type { SkiDomainConfig } from '@/lib/skiDomains';
import { buildSkiGraph, planRoute, trimRoute, type ClosedLines, type RouteResult, type RouteTarget, type SkiGraph, type SkiLevel } from '@/lib/skiRouting';
import type { RouteGoal, RouteStatus } from '@/components/domain/RouteCard';
import { SIM_SPEEDUP, SIM_TICK_MS, headingTo, pointAhead, simPath } from '@/components/domain/routeGeometry';
import type { DomainData } from './domainData';
import type { LabelHandle, SceneHandle } from './scene';

export interface Position {
  lng: number;
  lat: number;
  accuracy: number;
}

const metersBetween = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) =>
  Math.hypot((b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 110_574);

/** Arrivé à moins de cette distance de la destination (à vol d'oiseau) : fin du guidage (m). */
const ARRIVED_M = 60;

export function useRouting(options: {
  handle: SceneHandle | null;
  data: DomainData | null;
  domain: SkiDomainConfig;
  /** Position GPS (ou simulée), dans le domaine. */
  gpsStart: Position | null;
  live: LiveConditions | null;
  setHere: (h: Position | null) => void;
  setGeoStatus: (s: 'off' | 'on') => void;
  requestGps: () => void;
  onNotice: (text: string) => void;
}) {
  const { handle, data, domain, gpsStart, live, setHere, setGeoStatus, requestGps, onNotice } = options;
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeGoal, setRouteGoal] = useState<RouteGoal | null>(null);
  const [routeLevel, setRouteLevel] = useState<SkiLevel>('all');
  const [pickedStart, setPickedStart] = useState<{ lng: number; lat: number } | null>(null);
  const [picking, setPickingState] = useState(false);
  const pickingRef = useRef(false);
  const [routeStatus, setRouteStatus] = useState<RouteStatus>('idle');
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [closedCount, setClosedCount] = useState(0);
  const [navigating, setNavigating] = useState(false);
  const navigatingRef = useRef(false);
  const [simulating, setSimulating] = useState(false);
  const simulatingRef = useRef(false);
  const [simRoute, setSimRoute] = useState<RouteResult | null>(null);
  const [simDistance, setSimDistance] = useState(0);
  const graphRef = useRef<SkiGraph | null>(null);
  const framedRef = useRef('');

  const setPicking = (on: boolean) => {
    pickingRef.current = on;
    setPickingState(on);
  };

  const shownRoute = useMemo(
    () => (simulating && simRoute ? trimRoute(simRoute, simDistance) : routeStatus === 'ready' ? route : null),
    [simulating, simRoute, simDistance, route, routeStatus],
  );
  // Hors guidage, le point choisi prime ; pendant le guidage, la position GPS.
  const routeStart = navigating ? (gpsStart ?? pickedStart) : (pickedStart ?? gpsStart);
  const fromGps = !!gpsStart && routeStart === gpsStart;
  const startMarker = !fromGps ? pickedStart : null;
  const startKey = simulating
    ? 'simulation'
    : !routeStart
      ? ''
      : !fromGps
        ? `p${routeStart.lng},${routeStart.lat}`
        : navigating
          ? `g${Math.round(routeStart.lng * 2500)},${Math.round(routeStart.lat * 3500)}`
          : 'gps';

  // Tracés fermés (index dans le réseau, mêmes listes que data.tracks) ; hors saison, rien d'exclu.
  const closedKey = useMemo(() => {
    const o = live?.openings;
    if (!o?.source.ok || o.outOfSeason) return '';
    const shut = (states: Record<string, LiveItemState>) =>
      Object.entries(states)
        .filter(([, st]) => st.status === 'closed')
        .map(([id]) => id)
        .sort()
        .join(',');
    return `${shut(o.pistes)}|${shut(o.lifts)}`;
  }, [live]);

  const closedLines = (): ClosedLines | undefined => {
    if (!closedKey || !data) return undefined;
    const [p, l] = closedKey.split('|').map((x) => new Set(x ? x.split(',') : []));
    const index = (list: { osmId: number }[], ids: Set<string>) => new Set(list.flatMap((t, i) => (ids.has(String(t.osmId)) ? [i] : [])));
    return { pistes: index(data.tracks.pistes, p), lifts: index(data.tracks.lifts, l) };
  };
  const countClosed = (closed: ClosedLines | undefined) => {
    if (!closed || !data) return 0;
    const names = new Set<string>();
    closed.pistes.forEach((i) => names.add(`p|${data.tracks.pistes[i].name || i}|${data.tracks.pistes[i].detail}`));
    closed.lifts.forEach((i) => names.add(`l|${data.tracks.lifts[i].name || i}`));
    return names.size;
  };

  const goalTargets = (goal: RouteGoal): RouteTarget[] | 'lift' => {
    if (goal.kind === 'lift') return 'lift';
    if (goal.kind === 'poi') return [{ id: goal.poi.id, name: goal.poi.name, lng: goal.poi.lng, lat: goal.poi.lat }];
    if (goal.kind === 'place') return [goal.place];
    if (goal.kind === 'village') {
      const v = domain.valleys.flatMap((x) => x.villages).find((x) => x.name === goal.name);
      return v ? [{ id: `village/${v.name}`, name: v.name, lng: v.lng, lat: v.lat }] : [];
    }
    return (data?.pois ?? [])
      .filter((p) => (goal.category === 'restaurant' ? p.category === 'restaurant' || p.category === 'hut' : p.category === 'toilets' && p.kind === 'Toilettes'))
      .map((p) => ({ id: p.id, name: p.name, lng: p.lng, lat: p.lat }));
  };

  /** Fin de la simulation : la fausse position disparaît. */
  const endSimulation = () => {
    if (!simulatingRef.current) return;
    simulatingRef.current = false;
    setSimulating(false);
    setHere(null);
    setGeoStatus('off');
  };

  // Calcul (ou recalcul quand le skieur avance).
  useEffect(() => {
    if (!routeOpen || !routeGoal || !routeStart || !handle || !data) return;
    let stale = false;
    const run = async () => {
      if (!graphRef.current) {
        setRouteStatus('preparing');
        // Laisse s'afficher « Préparation… » ; le relief est déjà chargé par la scène.
        await new Promise((r) => setTimeout(r, 0));
        if (stale) return;
        graphRef.current = buildSkiGraph(data.tracks.pistes, data.tracks.lifts, (lng, lat) => handle.elevation(lng, lat));
      }
      const closed = closedLines();
      const result = planRoute(graphRef.current, routeStart, goalTargets(routeGoal), routeLevel, closed);
      setClosedCount(countClosed(closed));
      setRoute(result);
      setRouteStatus(result ? 'ready' : 'none');
      if (navigatingRef.current && fromGps && result && metersBetween(routeStart, result.target) < ARRIVED_M) {
        navigatingRef.current = false;
        setNavigating(false);
        endSimulation();
        onNotice(`Vous êtes arrivé : ${result.target.name}.`);
      }
    };
    void run();
    return () => {
      stale = true;
    };
    // Recalcul sur le départ arrondi (startKey), pas sur chaque position GPS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeOpen, routeGoal, routeLevel, startKey, closedKey, handle, data]);

  // Tracé, repères de départ et d'arrivée, cadrage quand la destination change.
  useEffect(() => {
    if (!handle) return;
    const shown = routeOpen ? shownRoute : null;
    handle.setRoute(shown?.steps ?? null, navigating);
    const marks: LabelHandle[] = [];
    const mark = (cls: string, lng: number, lat: number) => {
      // Repère dans un conteneur : CSS2DRenderer réécrit la transformation de l'élément posé.
      const el = document.createElement('div');
      el.appendChild(document.createElement('div')).className = cls;
      marks.push(handle.addLabel(el, lng, lat, { lift: 12, anchorBottom: cls === 'three-route-end' }));
    };
    if (routeOpen && startMarker) mark('three-route-start', startMarker.lng, startMarker.lat);
    if (shown) mark('three-route-end', shown.target.lng, shown.target.lat);

    const key = shown ? `${shown.target.id}|${routeLevel}|${startMarker ? `${startMarker.lng},${startMarker.lat}` : 'gps'}` : '';
    if (shown && key !== framedRef.current && !navigating) {
      const pts = shown.steps.flatMap((s) => s.coordinates);
      pts.push([shown.target.lng, shown.target.lat]);
      const lngs = pts.map((p) => p[0]);
      const lats = pts.map((p) => p[1]);
      const center = { lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
      const extent = metersBetween({ lng: Math.min(...lngs), lat: Math.min(...lats) }, { lng: Math.max(...lngs), lat: Math.max(...lats) });
      handle.flyTo({ ...center, distance: Math.max(1500, extent * 1.6), pitch: 55 });
    }
    framedRef.current = key;
    return () => marks.forEach((m) => m.remove());
  }, [handle, shownRoute, routeOpen, startMarker, routeLevel, navigating]);

  // Guidage : la caméra suit le skieur en continu (lissée par la scène, sans à-coups entre deux
  // positions), tournée vers la suite de l'itinéraire.
  useEffect(() => {
    if (!handle || !navigating || !gpsStart) return;
    const ahead = shownRoute ? pointAhead(shownRoute, 200) : null;
    handle.follow({ lng: gpsStart.lng, lat: gpsStart.lat, bearing: ahead ? headingTo(gpsStart, ahead) : undefined });
  }, [handle, navigating, gpsStart, shownRoute]);
  useEffect(() => {
    if (handle && !navigating) handle.follow(null);
  }, [handle, navigating]);

  // Simulation : la position avance toute seule le long de l'itinéraire figé.
  useEffect(() => {
    if (!simulating || !simRoute) return;
    const path = simPath(simRoute);
    if (path.length < 2) return;
    let travelled = 0;
    let i = 0;
    let { lng, lat } = path[0];
    const tick = () => {
      let budget = (path[Math.min(i + 1, path.length - 1)].speed * SIM_SPEEDUP * SIM_TICK_MS) / 1000;
      while (budget > 0 && i < path.length - 1) {
        const next = path[i + 1];
        const d = metersBetween({ lng, lat }, next);
        if (d <= budget) {
          budget -= d;
          travelled += d;
          ({ lng, lat } = next);
          i++;
        } else {
          lng += ((next.lng - lng) * budget) / d;
          lat += ((next.lat - lat) * budget) / d;
          travelled += budget;
          budget = 0;
        }
      }
      setHere({ lng, lat, accuracy: 5 });
      setGeoStatus('on');
      setSimDistance(travelled);
      if (i >= path.length - 1) {
        clearInterval(timer);
        onNotice(`Vous êtes arrivé : ${simRoute.target.name}. Fin de la simulation.`);
        navigatingRef.current = false;
        setNavigating(false);
        endSimulation();
      }
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, SIM_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulating, simRoute]);

  const openRoute = (goal?: RouteGoal) => {
    setRouteOpen(true);
    if (goal) setRouteGoal(goal);
    // Départ par défaut : la position (demandée si besoin) ; un autre point se choisit depuis la fiche.
    if (!pickedStart && !gpsStart) requestGps();
  };
  const stopNavigation = () => {
    navigatingRef.current = false;
    setNavigating(false);
    endSimulation();
  };
  const closeRoute = () => {
    stopNavigation();
    setRouteOpen(false);
    setPicking(false);
  };
  const startNavigation = () => {
    setPicking(false);
    navigatingRef.current = true;
    setNavigating(true);
    if (!gpsStart) requestGps();
  };
  const startSimulation = () => {
    if (!route) return;
    setSimRoute(route);
    setSimDistance(0);
    setPicking(false);
    navigatingRef.current = true;
    setNavigating(true);
    simulatingRef.current = true;
    setSimulating(true);
  };
  /** « Y aller » : itinéraire, et guidage tout de suite si un départ est connu. */
  const goTo = (goal: RouteGoal) => {
    openRoute(goal);
    if (gpsStart || pickedStart) startNavigation();
  };

  return {
    routeOpen,
    routeGoal,
    setRouteGoal,
    routeLevel,
    setRouteLevel,
    pickedStart,
    /** Départ choisi au toucher de la carte (mode « choisir le départ »). */
    pickStart(lng: number, lat: number) {
      setPickedStart({ lng, lat });
      setPicking(false);
    },
    useGps: () => setPickedStart(null),
    picking,
    pickingRef,
    setPicking,
    routeStatus,
    route,
    shownRoute,
    closedCount,
    navigating,
    simulating,
    hasStart: !!routeStart,
    openRoute,
    closeRoute,
    startNavigation,
    startSimulation,
    stopNavigation,
    goTo,
  };
}
