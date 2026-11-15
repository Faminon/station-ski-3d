// Corrections d'un domaine par rapport à OpenStreetMap, d'après le plan des
// pistes officiel de la saison : noms manquants ou changés, pistes et
// remontées absentes d'OSM, tracées à la main sur les photos aériennes IGN
// (public/data/<domaine>-corrections.json). La carte 3D les applique au tracé
// du domaine avant de l'afficher.

// Sans dépendance à MapLibre : utilisé aussi côté serveur, pour les chiffres du domaine.
import { METERS_PER_DEG_LAT, metersPerDegLng, type PisteDifficulty, type StationPisteMap } from '@/lib/apis/overpass';
import type { DomainPoi } from '@/lib/domainPois';

export interface DomainCorrections {
  /** Source des corrections (plan officiel, saison). */
  source: string;
  /** Nouveau nom d'un tracé OSM, par identifiant de chemin (« way ») OpenStreetMap. */
  rename?: { osmId: number; name: string; was?: string }[];
  /** Tracés OSM absents du plan officiel (itinéraires hors-piste, pistes disparues), retirés de la carte. */
  remove?: { osmId: number; name?: string; why: string }[];
  /** Pistes absentes d'OSM, tracées à la main en [lng, lat] (du haut vers le bas). */
  pistes?: { name: string; difficulty: PisteDifficulty; coordinates: [number, number][] }[];
  /** Remontées absentes d'OSM, en [lng, lat] (du bas vers le haut). */
  lifts?: { name: string; liftType: string; coordinates: [number, number][] }[];
  /** Lieux (restaurants d'altitude…) absents d'OSM ou mal nommés, d'après les offices de tourisme. */
  pois?: {
    /** Nouveau nom d'un lieu OSM, par identifiant (« node/123 », « way/456 »). */
    rename?: { id: string; name: string; was?: string }[];
    /** Lieux OSM à retirer (doublons d'un lieu ajouté ci-dessous, lieu fermé). */
    remove?: { id: string; why: string }[];
    /** Lieux absents d'OSM ; `source` : page d'où viennent le nom et les coordonnées. */
    add?: (Omit<DomainPoi, 'id'> & { id: string; source: string })[];
  };
}

/** Lieux du domaine corrigés (copie ; l'original n'est pas modifié). */
export function applyPoiCorrections(pois: DomainPoi[], corrections: DomainCorrections | null): DomainPoi[] {
  const fix = corrections?.pois;
  if (!fix) return pois;
  const names = new Map((fix.rename ?? []).map((r) => [r.id, r.name]));
  const removed = new Set((fix.remove ?? []).map((r) => r.id));
  const kept = pois.filter((p) => !removed.has(p.id)).map((p) => (names.has(p.id) ? { ...p, name: names.get(p.id)! } : p));
  // Un ajout repris entre-temps par l'extraction OSM (même identifiant) n'est pas doublé.
  const known = new Set(kept.map((p) => p.id));
  return [
    ...kept,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ...(fix.add ?? []).filter((p) => !known.has(p.id)).map(({ source, ...p }) => p),
  ];
}

/** Tracé du domaine corrigé (copie ; l'original n'est pas modifié). */
export function applyCorrections(map: StationPisteMap, corrections: DomainCorrections | null): StationPisteMap {
  if (!corrections) return map;
  const { lat: cLat, lng: cLng } = map.center;
  const mx = metersPerDegLng(cLat);
  // Même repère que le tracé enregistré : mètres autour du centre, y vers le sud.
  const toPoints = (coords: [number, number][]) => coords.map(([lng, lat]) => ({ x: Math.round((lng - cLng) * mx), y: Math.round(-(lat - cLat) * METERS_PER_DEG_LAT) }));
  const length = (pts: { x: number; y: number }[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

  const names = new Map((corrections.rename ?? []).map((r) => [r.osmId, r.name]));
  const removed = new Set((corrections.remove ?? []).map((r) => r.osmId));
  // Identifiants négatifs : ils ne peuvent pas entrer en conflit avec ceux d'OSM.
  let nextId = -1;
  return {
    ...map,
    pistes: [
      ...map.pistes.filter((p) => !removed.has(p.id)).map((p) => (names.has(p.id) ? { ...p, name: names.get(p.id) } : p)),
      ...(corrections.pistes ?? []).map((p) => {
        const points = toPoints(p.coordinates);
        return { id: nextId--, name: p.name, difficulty: p.difficulty, length: Math.round(length(points)), points };
      }),
    ],
    lifts: [
      ...map.lifts.filter((l) => !removed.has(l.id)).map((l) => (names.has(l.id) ? { ...l, name: names.get(l.id) } : l)),
      ...(corrections.lifts ?? []).map((l) => {
        const points = toPoints(l.coordinates);
        return { id: nextId--, name: l.name, liftType: l.liftType, length: Math.round(length(points)), points };
      }),
    ],
  };
}
