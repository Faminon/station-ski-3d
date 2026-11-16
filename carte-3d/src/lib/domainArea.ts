// Emprise d'un domaine : pistes et remontées, plus une marge. Sert au paquet hors ligne
// (zone détaillée, scripts/buildOfflinePack.ts) et à la carte Three.js (relief détaillé).

import type { StationPisteMap } from './apis/overpass';

const METERS_PER_DEG_LAT = 110_574;

/** [ouest, sud, est, nord] des pistes et remontées, élargi de `marginKm`. */
export function domainDetailBounds(map: StationPisteMap, marginKm: number): [number, number, number, number] {
  const { lat, lng } = map.center;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const m = marginKm * 1000;
  const { minX, maxX, minY, maxY } = map.bounds;
  // Plan des pistes : x vers l'est, y vers le sud, en mètres autour du centre.
  return [lng + (minX - m) / mPerDegLng, lat - (maxY + m) / METERS_PER_DEG_LAT, lng + (maxX + m) / mPerDegLng, lat - (minY - m) / METERS_PER_DEG_LAT];
}
