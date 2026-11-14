// Zones de snowpark et zones ludiques, dessinées en grand comme sur les plans
// des pistes peints : l'emprise réelle quand OpenStreetMap la connaît (surface
// ou tracé du parc), sinon une zone d'une centaine de mètres autour du point.

import type { FeatureCollection } from 'geojson';
import type { DomainPoi, ParkZone } from '@/lib/domainPois';
import { METERS_PER_DEG_LAT, metersPerDegLng } from '@/components/station/map3d';

export const PARK_COLORS = { snowpark: '#f76707', playground: '#fab005' } as const;
/** Rayon de la zone dessinée autour d'un snowpark connu seulement par un point. */
const POINT_ZONE_M = 110;

const label = (kind: ParkZone['kind'], name?: string) => (name ? name : kind === 'snowpark' ? 'Snowpark' : 'Zone ludique');

function circle(lng: number, lat: number, radius: number): number[][] {
  const mx = metersPerDegLng(lat);
  const ring = Array.from({ length: 33 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [lng + (Math.cos(a) * radius) / mx, lat + (Math.sin(a) * radius) / METERS_PER_DEG_LAT];
  });
  ring[32] = ring[0];
  return ring;
}

/** Surfaces, tracés et étiquettes des parcs du domaine. */
export function parkZoneFeatures(zones: ParkZone[], pois: DomainPoi[]): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  const centers: { lng: number; lat: number }[] = [];
  for (const z of zones) {
    const props = { kind: z.kind, label: label(z.kind, z.name) };
    features.push(
      z.closed
        ? { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [z.coordinates] } }
        : { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: z.coordinates } },
    );
    const lng = z.coordinates.reduce((s, c) => s + c[0], 0) / z.coordinates.length;
    const lat = z.coordinates.reduce((s, c) => s + c[1], 0) / z.coordinates.length;
    centers.push({ lng, lat });
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } });
  }
  // Snowparks connus seulement par un point : zone dessinée autour, sauf s'il est déjà dans une emprise.
  for (const p of pois) {
    if (p.category !== 'snowpark' || p.kind === 'Tremplin') continue;
    const mx = metersPerDegLng(p.lat);
    if (centers.some((c) => Math.hypot((c.lng - p.lng) * mx, (c.lat - p.lat) * METERS_PER_DEG_LAT) < 250)) continue;
    const kind = p.kind === 'Zone ludique' ? 'playground' : 'snowpark';
    const props = { kind, label: label(kind, p.name === p.kind ? undefined : p.name) };
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [circle(p.lng, p.lat, POINT_ZONE_M)] } });
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
  }
  return { type: 'FeatureCollection', features };
}
