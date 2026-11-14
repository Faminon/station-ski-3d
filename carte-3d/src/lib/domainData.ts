// Lecture côté serveur uniquement (node:fs) : fichiers de public/data, exportés du
// site de recherche (prisma/exportDomainMaps.ts, là-bas).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuiltArea } from '@/components/domain/mountainBuildings';
import type { StationPisteMap } from '@/lib/apis/overpass';
import { applyCorrections, type DomainCorrections } from '@/lib/domainCorrections';
import { computePisteStats, type PisteStats } from '@/lib/pisteStats';
import type { SkiDomainConfig } from '@/lib/skiDomains';

export interface DomainData {
  /** Chiffres du domaine (pistes par couleur, remontées…), corrections comprises. */
  stats: PisteStats;
  /** Stations du domaine présentes sur le site de recherche ; `village` : bâtiments fournis. */
  stations: { id: string; name: string; village: boolean }[];
  builtAreas: BuiltArea[];
}

function readJson<T>(url: string | undefined): T | null {
  if (!url) return null;
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'public', url), 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Données d'un domaine nécessaires au rendu de la page, ou null si son tracé n'a pas été exporté. */
export function loadDomainData(domain: SkiDomainConfig): DomainData | null {
  const map = readJson<StationPisteMap>(domain.pistesUrl);
  if (!map) return null;
  const meta = readJson<Pick<DomainData, 'stations' | 'builtAreas'>>(domain.stationsUrl);
  // Corrections d'après le plan officiel : comptées comme elles sont dessinées sur la carte.
  const corrections = readJson<DomainCorrections>(domain.correctionsUrl);
  return {
    stats: computePisteStats(applyCorrections(map, corrections)),
    stations: meta?.stations ?? [],
    builtAreas: meta?.builtAreas ?? [],
  };
}
