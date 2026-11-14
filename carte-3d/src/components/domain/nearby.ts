// « Ma position » sur la carte du domaine : piste, remontée et restaurant les
// plus proches du skieur, et distance au domaine quand il en est loin.
// Calculs en mètres dans un repère local (équirectangulaire), largement assez
// précis à l'échelle d'un domaine skiable.

import { METERS_PER_DEG_LAT, metersPerDegLng } from '@/components/station/map3d';

export interface NamedLine {
  name: string;
  /** Difficulté (pistes) ou type (remontées). */
  detail: string;
  coordinates: number[][];
}

export interface NamedPoint {
  name: string;
  lng: number;
  lat: number;
}

export interface Nearest<T> {
  item: T;
  /** Distance en mètres. */
  distance: number;
}

function toLocal(lng: number, lat: number, lat0: number): [number, number] {
  return [lng * metersPerDegLng(lat0), lat * METERS_PER_DEG_LAT];
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Tracé le plus proche du point ; les tracés sans nom (liaisons) sont ignorés si `namedOnly`. */
export function nearestLine<T extends NamedLine>(lng: number, lat: number, lines: T[], namedOnly = true): Nearest<T> | null {
  const [px, py] = toLocal(lng, lat, lat);
  let best: Nearest<T> | null = null;
  for (const line of lines) {
    if (namedOnly && !line.name) continue;
    const pts = line.coordinates.map(([x, y]) => toLocal(x, y, lat));
    for (let i = 1; i < pts.length; i++) {
      const d = segmentDistance(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (!best || d < best.distance) best = { item: line, distance: d };
    }
  }
  return best;
}

export function nearestPoint<T extends NamedPoint>(lng: number, lat: number, points: T[]): Nearest<T> | null {
  const [px, py] = toLocal(lng, lat, lat);
  let best: Nearest<T> | null = null;
  for (const p of points) {
    const [x, y] = toLocal(p.lng, p.lat, lat);
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.distance) best = { item: p, distance: d };
  }
  return best;
}

/** « 40 m », « 1,2 km ». */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}
