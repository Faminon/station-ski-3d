// Géométrie des itinéraires, commune aux cartes MapLibre et Three.js : cap vers la suite du
// trajet, point devant le skieur, trajet de la position simulée.

import type { RouteResult } from '@/lib/skiRouting';

/** Simulation du trajet : accélération par rapport à un vrai skieur, et cadence des positions. */
export const SIM_SPEEDUP = 8;
export const SIM_TICK_MS = 400;

/** Trajet suivi par la position simulée : les points de l'itinéraire, avec la vitesse de chaque étape. */
export function simPath(route: RouteResult) {
  return route.steps.flatMap((s) => s.coordinates.map(([lng, lat]) => ({ lng, lat, speed: s.kind === 'lift' ? 5 : s.kind === 'walk' ? 2.5 : 7 })));
}

/** Cap (degrés) d'un point vers un autre, pour orienter la vue dans le sens de la marche. */
export function headingTo(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const dx = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** Point de l'itinéraire à `meters` mètres du départ (pour viser devant le skieur). */
export function pointAhead(route: RouteResult, meters: number): { lng: number; lat: number } | null {
  const pts = route.steps.flatMap((s) => s.coordinates);
  let left = meters;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const d = Math.hypot((x1 - x0) * 111_320 * Math.cos((y0 * Math.PI) / 180), (y1 - y0) * 110_574);
    if (d >= left && d > 0) return { lng: x0 + ((x1 - x0) * left) / d, lat: y0 + ((y1 - y0) * left) / d };
    left -= d;
  }
  const last = pts[pts.length - 1];
  return last ? { lng: last[0], lat: last[1] } : null;
}
