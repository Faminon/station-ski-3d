// Corrections d'un domaine par rapport à OpenStreetMap, d'après le plan des
// pistes officiel de la saison : noms manquants ou changés, pistes et
// remontées absentes d'OSM, tracées à la main sur les photos aériennes IGN
// (public/data/<domaine>-corrections.json). La carte 3D les applique au tracé
// du domaine avant de l'afficher.

// Sans dépendance à MapLibre : utilisé aussi côté serveur, pour les chiffres du domaine.
import { METERS_PER_DEG_LAT, metersPerDegLng, type PisteDifficulty, type StationPisteMap } from '@/lib/apis/overpass';

export interface DomainCorrections {
  /** Source des corrections (plan officiel, saison). */
  source: string;
  /** Nouveau nom d'un tracé OSM, par identifiant de chemin (« way ») OpenStreetMap. */
  rename?: { osmId: number; name: string; was?: string }[];
  /** Pistes absentes d'OSM, tracées à la main en [lng, lat] (du haut vers le bas). */
  pistes?: { name: string; difficulty: PisteDifficulty; coordinates: [number, number][] }[];
  /** Remontées absentes d'OSM, en [lng, lat] (du bas vers le haut). */
  lifts?: { name: string; liftType: string; coordinates: [number, number][] }[];
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
  // Identifiants négatifs : ils ne peuvent pas entrer en conflit avec ceux d'OSM.
  let nextId = -1;
  return {
    ...map,
    pistes: [
      ...map.pistes.map((p) => (names.has(p.id) ? { ...p, name: names.get(p.id) } : p)),
      ...(corrections.pistes ?? []).map((p) => {
        const points = toPoints(p.coordinates);
        return { id: nextId--, name: p.name, difficulty: p.difficulty, length: Math.round(length(points)), points };
      }),
    ],
    lifts: [
      ...map.lifts.map((l) => (names.has(l.id) ? { ...l, name: names.get(l.id) } : l)),
      ...(corrections.lifts ?? []).map((l) => {
        const points = toPoints(l.coordinates);
        return { id: nextId--, name: l.name, liftType: l.liftType, length: Math.round(length(points)), points };
      }),
    ],
  };
}
