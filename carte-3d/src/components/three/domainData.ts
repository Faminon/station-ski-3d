// Données d'un domaine pour la carte Three.js : les mêmes que la carte MapLibre (plan des
// pistes corrigé, lieux corrigés, forêts), chargées une fois.

import type { StationPisteMap } from '@/lib/apis/overpass';
import { applyCorrections, applyPoiCorrections, type DomainCorrections } from '@/lib/domainCorrections';
import type { DomainPoi, DomainPois, ParkZone } from '@/lib/domainPois';
import type { SkiDomainConfig } from '@/lib/skiDomains';
import { lineLength } from '@/lib/skiRouting';
import type { NamedLine } from '@/components/domain/nearby';
import type { BuiltArea } from '@/components/domain/mountainBuildings';
import { pisteLngLat } from './overlays';

/** Piste ou remontée : nom, difficulté ou type (`detail`), tracé en [lng, lat]. */
export interface TrackLine extends NamedLine {
  kind: 'piste' | 'lift';
  /** Identifiant OpenStreetMap (négatif pour une correction) : clé des conditions en direct. */
  osmId: number;
  length: number;
}

export interface DomainData {
  pistes: StationPisteMap;
  forests: GeoJSON.FeatureCollection;
  /** Routes et rues (classe `cls` : major, road, street ; numéro `ref`). */
  roads: GeoJSON.FeatureCollection;
  pois: DomainPoi[];
  /** Emprises des snowparks et zones ludiques, quand OpenStreetMap les dessine. */
  parkZones: ParkZone[];
  tracks: { pistes: TrackLine[]; lifts: TrackLine[] };
  /** Stations dont les bâtiments réels sont fournis (/data/villages/<id>.json). */
  villageIds: string[];
  /** Zones couvertes par ces bâtiments : leurs lieux n'ont pas besoin de bâtiment dessiné. */
  builtAreas: BuiltArea[];
}

const json = <T,>(url: string | undefined): Promise<T | null> =>
  url
    ? fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
        .catch(() => null)
    : Promise.resolve(null);

export async function loadDomainData(domain: SkiDomainConfig): Promise<DomainData> {
  const [raw, forests, pois, corrections, stations, roads] = await Promise.all([
    json<StationPisteMap>(domain.pistesUrl),
    json<GeoJSON.FeatureCollection>(domain.forestsUrl),
    json<DomainPois>(domain.poisUrl),
    json<DomainCorrections>(domain.correctionsUrl),
    json<{ stations: { id: string; village?: boolean }[]; builtAreas?: BuiltArea[] }>(domain.stationsUrl),
    json<GeoJSON.FeatureCollection>(domain.roadsUrl),
  ]);
  if (!raw) throw new Error('Plan des pistes introuvable.');
  // Corrections du plan officiel (tracés, noms, difficultés), comme sur la carte MapLibre.
  const pistes = applyCorrections(raw, corrections);
  const toLngLat = pisteLngLat(pistes);
  const track = (kind: TrackLine['kind'], f: { id: number; name?: string; points: { x: number; y: number }[] }, detail: string): TrackLine => {
    const coordinates = f.points.map(toLngLat);
    return { kind, osmId: f.id, name: f.name ?? '', detail, coordinates, length: lineLength(coordinates) };
  };
  return {
    pistes,
    forests: forests ?? { type: 'FeatureCollection', features: [] },
    roads: roads ?? { type: 'FeatureCollection', features: [] },
    pois: pois ? applyPoiCorrections(pois.pois, corrections) : [],
    parkZones: pois?.zones ?? [],
    tracks: {
      pistes: pistes.pistes.map((p) => track('piste', p, p.difficulty)),
      lifts: pistes.lifts.map((l) => track('lift', l, l.liftType)),
    },
    villageIds: (stations?.stations ?? []).filter((s) => s.village).map((s) => s.id),
    builtAreas: stations?.builtAreas ?? [],
  };
}
