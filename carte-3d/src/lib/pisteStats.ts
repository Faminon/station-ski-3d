import type { PisteDifficulty, StationPisteMap } from '@/lib/apis/overpass';

export interface PisteStats {
  slopes: number;
  totalKm: number;
  lifts: number;
  byDifficulty: Record<PisteDifficulty, number>;
}

// Types `aerialway` qui ne transportent pas de skieurs : gares, tyroliennes,
// monte-charges. Les compter gonflerait le total des remontées.
const NON_SKIER_LIFTS = new Set(['station', 'zip_line', 'goods', 'yes', 'pylon']);

/** Remontée qui transporte des skieurs — même filtre pour la carte et l'encart. */
export const isSkierLift = (liftType: string) => !NON_SKIER_LIFTS.has(liftType);

/**
 * Chiffres du domaine tirés du même tracé que le plan des pistes, pour que
 * l'encart « Domaine skiable » et la carte disent la même chose.
 * OpenStreetMap découpe une piste en plusieurs tronçons : une piste nommée est
 * comptée une fois par couple (difficulté, nom) ; les tronçons sans nom sont
 * des liaisons et ne comptent pas comme pistes.
 */
export function computePisteStats(map: StationPisteMap): PisteStats {
  const byDifficulty: Record<PisteDifficulty, number> = { green: 0, blue: 0, red: 0, black: 0, unknown: 0 };
  const seen = new Set<string>();
  let meters = 0;
  for (const p of map.pistes) {
    meters += p.length;
    if (!p.name) continue;
    const key = `${p.difficulty}|${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byDifficulty[p.difficulty]++;
  }
  return {
    slopes: seen.size,
    totalKm: Math.round(meters / 1000),
    lifts: map.lifts.filter((l) => isSkierLift(l.liftType)).length,
    byDifficulty,
  };
}

/** Colonnes `Station` correspondantes, pour stocker ces chiffres en base. */
export function statsColumns(stats: PisteStats) {
  return {
    slopes: stats.slopes,
    totalKmSlopes: stats.totalKm,
    lifts: stats.lifts,
    greenSlopes: stats.byDifficulty.green,
    blueSlopes: stats.byDifficulty.blue,
    redSlopes: stats.byDifficulty.red,
    blackSlopes: stats.byDifficulty.black,
  };
}
