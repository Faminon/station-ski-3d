// Modules de freestyle en 3D dans les snowparks : sauts (tremplin, table,
// réception), rails et box, alignés sur toute la descente du parc, du haut
// vers le bas. Le sens de la pente est lu dans le relief (terrainSampler) :
// OpenStreetMap ne dit pas où le parc commence.
//
// Volumes « fill-extrusion » posés sur le relief, comme les remontées : un
// tremplin est une petite pile de marches de plus en plus hautes, ce qui
// dessine une rampe vue d'un peu loin.

import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { METERS_PER_DEG_LAT, metersPerDegLng } from '@/components/station/map3d';
import { loadTerrain } from './terrainSampler';

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function distToSegment(x: number, y: number, [ax, ay]: number[], [bx, by]: number[]): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

export const PARK_FEATURES_LAYER = 'park-features';
const MIN_ZOOM = 14;
/** Modules grossis : à taille réelle, un rail ne fait qu'un trait d'un pixel. */
const S = 1.5;

const SNOW = '#f5f9fc';
const SNOW_SHADE = '#e3ecf3';
const LIP = '#1c7ed6';
const RAIL = '#f08c00';
const BOX = '#1971c2';
const STEEL = '#495057';

type Volume = Feature<Polygon, { c: string; b: number; h: number }>;
type XY = [number, number];

/** Repère local d'une zone : mètres autour de son premier point. */
interface Frame {
  lng0: number;
  lat0: number;
  mx: number;
  /** Point (repère local) trop proche d'une remontée : pas de module à cet endroit. */
  blocked: (x: number, y: number) => boolean;
}

/** Distance minimale entre un module et l'axe d'une remontée (pylônes, perches, câbles 3D). */
const LIFT_CLEARANCE_M = 10;
/** Longueur de chaque type de ligne, écart compris : un saut (tremplin, table, réception) prend plus de place. */
const JUMP_ROW_M = 34;
const RAIL_ROW_M = 22;

function box(out: Volume[], f: Frame, [x, y]: XY, [ux, uy]: XY, along: number, across: number, b: number, h: number, c: string) {
  // (uy, -ux) : à droite du sens de la descente.
  const corner = (sa: number, sr: number) => [
    f.lng0 + (x + ux * along * sa + uy * across * sr) / f.mx,
    f.lat0 + (y + uy * along * sa - ux * across * sr) / METERS_PER_DEG_LAT,
  ];
  const ring = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
  ring.push(ring[0]);
  out.push({ type: 'Feature', properties: { c, b: b * S, h: h * S }, geometry: { type: 'Polygon', coordinates: [ring] } });
}

/** Saut : tremplin en marches, table, réception en pente. `at` = pied du tremplin. Longueur ≈ 17 m. */
function jump(out: Volume[], f: Frame, at: XY, u: XY, width: number) {
  const p = (d: number, side = 0): XY => [at[0] + u[0] * d * S + u[1] * side, at[1] + u[1] * d * S - u[0] * side];
  for (let i = 0; i < 4; i++) box(out, f, p(0.6 + i * 1.2), u, 0.6 * S, width / 2, 0, 0.55 * (i + 1), SNOW);
  // Lèvre du tremplin, teintée comme les lignes de repère des parcs.
  box(out, f, p(4.7), u, 0.15 * S, width / 2, 2.2, 2.32, LIP);
  box(out, f, p(7.5), u, 2.6 * S, width / 2 + 0.6, 0, 1.9, SNOW_SHADE);
  [1.55, 1.15, 0.8, 0.45, 0.2].forEach((h, i) => box(out, f, p(11 + i * 1.2), u, 0.6 * S, width / 2 + 0.6, 0, h, SNOW));
}

/** Rail sur poteaux, avec sa petite rampe d'appel. */
function rail(out: Volume[], f: Frame, at: XY, u: XY) {
  const p = (d: number): XY => [at[0] + u[0] * d * S, at[1] + u[1] * d * S];
  box(out, f, p(0.6), u, 0.6 * S, 0.9, 0, 0.5, SNOW);
  box(out, f, p(1.8), u, 0.6 * S, 0.9, 0, 0.85, SNOW);
  box(out, f, p(6.5), u, 4 * S, 0.22, 0.9, 1.15, RAIL);
  for (const d of [3, 6.5, 10]) box(out, f, p(d), u, 0.12 * S, 0.12, 0, 0.9, STEEL);
}

/** Box : caisson plat et large, à glisser. */
function slideBox(out: Volume[], f: Frame, at: XY, u: XY) {
  const p = (d: number): XY => [at[0] + u[0] * d * S, at[1] + u[1] * d * S];
  box(out, f, p(1.2), u, 1.2 * S, 1.1, 0, 0.6, SNOW);
  box(out, f, p(6), u, 3.6 * S, 0.75, 0, 0.85, BOX);
}

/** Point et direction (unitaire, vers le bas) à la distance `d` d'une polyligne. */
function along(line: XY[], cum: number[], d: number): { p: XY; u: XY } {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
  const [ax, ay] = line[i - 1];
  const [bx, by] = line[i];
  return { p: [ax + (bx - ax) * t, ay + (by - ay) * t], u: [(bx - ax) / seg, (by - ay) / seg] };
}

/** Lignes de 2 ou 3 modules côte à côte selon la largeur disponible. */
const lanesFor = (width: number) => (width >= 40 ? [-9, 0, 9] : width >= 24 ? [-5, 5] : [0]);

/** Une ligne de modules : un saut par couloir une ligne sur trois, sinon rails et box en alternance. */
function placeRow(out: Volume[], f: Frame, p: XY, u: XY, width: number, row: number) {
  const lanes = lanesFor(width);
  const isJump = row % 3 === 0;
  const length = (isJump ? JUMP_ROW_M - 8 : RAIL_ROW_M - 6) * (S / 1.5);
  lanes.forEach((side, i) => {
    const at: XY = [p[0] + u[1] * side, p[1] - u[0] * side];
    // Module écarté s'il passerait sous une remontée (début, milieu ou fin de son emprise).
    for (const d of [0, length / 2, length]) if (f.blocked(at[0] + u[0] * d, at[1] + u[1] * d)) return;
    if (isJump) jump(out, f, at, u, i === Math.floor(lanes.length / 2) ? 5.5 : 4.2);
    else if ((i + row) % 2 === 0) rail(out, f, at, u);
    else slideBox(out, f, at, u);
  });
}

/** Avance jusqu'à la ligne suivante : les sauts sont plus longs que les rails et les box. */
const rowStep = (row: number) => (row % 3 === 0 ? JUMP_ROW_M : RAIL_ROW_M);

/** Parc tracé en ligne : modules le long du tracé `line` (mètres, du haut vers le bas). */
function layoutRun(out: Volume[], f: Frame, line: XY[], width: number) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const length = cum[cum.length - 1];
  for (let d = 12, row = 0; d < length - 20; d += rowStep(row), row++) {
    const { p, u } = along(line, cum, d);
    placeRow(out, f, p, u, width, row);
  }
}

/**
 * Parc en surface : on descend selon `u` (du point le plus haut vers le plus bas) et, à
 * chaque ligne, on se place au milieu de la largeur du parc à cette hauteur.
 */
function layoutArea(out: Volume[], f: Frame, ring: XY[], u: XY) {
  // t : distance dans le sens de la descente ; s : écart latéral (à droite positif).
  const ts = ring.map(([x, y]) => x * u[0] + y * u[1]);
  const ss = ring.map(([x, y]) => x * u[1] - y * u[0]);
  const [tMin, tMax] = [Math.min(...ts), Math.max(...ts)];
  for (let t = tMin + 12, row = 0; t < tMax - 20; t += rowStep(row), row++) {
    // Coupe du contour à cette hauteur : bords gauche et droit du parc.
    const cuts: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      if (ts[i] <= t !== ts[j] <= t) cuts.push(ss[i] + ((t - ts[i]) / (ts[j] - ts[i])) * (ss[j] - ss[i]));
    }
    if (cuts.length < 2) continue;
    const [left, right] = [Math.min(...cuts), Math.max(...cuts)];
    const s = (left + right) / 2;
    // Retour en x, y : t le long de u, s à droite de u.
    const p: XY = [u[0] * t + u[1] * s, u[1] * t - u[0] * s];
    placeRow(out, f, p, u, right - left, row);
  }
}

/**
 * Ajoute les modules des parcs `zones` (sortie de parkZoneFeatures : surfaces et
 * tracés). Le calque est créé tout de suite (vide) pour suivre la case
 * « Snowparks » du panneau ; les modules arrivent avec les tuiles de relief.
 */
export function addParkFeatures(map: MlMap, zones: FeatureCollection, lifts: number[][][], visible: boolean, beforeId?: string): Promise<void> {
  map.addSource(PARK_FEATURES_LAYER, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, tolerance: 0 });
  map.addLayer(
    {
      id: PARK_FEATURES_LAYER,
      type: 'fill-extrusion',
      source: PARK_FEATURES_LAYER,
      minzoom: MIN_ZOOM,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'fill-extrusion-color': ['get', 'c'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true,
      },
    },
    beforeId,
  );

  const parks = zones.features.filter(
    (z): z is Feature<Polygon> | Feature<GeoJSON.LineString> =>
      (z.geometry.type === 'Polygon' || z.geometry.type === 'LineString') && z.properties?.kind === 'snowpark',
  );
  if (!parks.length) return Promise.resolve();
  // Un même parc est souvent décrit deux fois (surface et tracé, ou zone autour de son point) :
  // on garde la surface, et un seul jeu de modules par endroit.
  const polygons = parks.filter((z): z is Feature<Polygon> => z.geometry.type === 'Polygon').map((z) => z.geometry.coordinates[0]);
  const insideAny = ([lng, lat]: number[], rings: number[][][]) => rings.some((ring) => pointInRing(lng, lat, ring));
  const kept: Feature<Polygon | GeoJSON.LineString>[] = [];
  const keptRings: number[][][] = [];
  for (const z of parks) {
    const coords = z.geometry.type === 'Polygon' ? z.geometry.coordinates[0] : z.geometry.coordinates;
    const mid = [coords.reduce((a, c) => a + c[0], 0) / coords.length, coords.reduce((a, c) => a + c[1], 0) / coords.length];
    if (z.geometry.type === 'LineString' ? insideAny(coords[Math.floor(coords.length / 2)], polygons) : insideAny(mid, keptRings)) continue;
    kept.push(z);
    if (z.geometry.type === 'Polygon') keptRings.push(z.geometry.coordinates[0]);
  }
  const all = parks.flatMap((z) => (z.geometry.type === 'Polygon' ? z.geometry.coordinates[0] : z.geometry.coordinates));
  const bbox: [number, number, number, number] = [
    Math.min(...all.map((c) => c[0])),
    Math.min(...all.map((c) => c[1])),
    Math.max(...all.map((c) => c[0])),
    Math.max(...all.map((c) => c[1])),
  ];

  return loadTerrain(bbox)
    .then((terrain) => {
      const out: Volume[] = [];
      for (const z of kept) {
        const coords = z.geometry.type === 'Polygon' ? z.geometry.coordinates[0].slice(0, -1) : z.geometry.coordinates;
        const [lng0, lat0] = coords[0];
        const mx = metersPerDegLng(lat0);
        // Remontées proches du parc, en repère local.
        const near = lifts
          .filter((l) => l.some(([lng, lat]) => Math.abs(lng - lng0) * mx < 2000 && Math.abs(lat - lat0) * METERS_PER_DEG_LAT < 2000))
          .map((l) => l.map(([lng, lat]): XY => [(lng - lng0) * mx, (lat - lat0) * METERS_PER_DEG_LAT]));
        const blocked = (x: number, y: number) =>
          near.some((l) => l.some((a, i) => i > 0 && distToSegment(x, y, l[i - 1], a) < LIFT_CLEARANCE_M));
        const f: Frame = { lng0, lat0, mx, blocked };
        const toXY = ([lng, lat]: number[]): XY => [(lng - lng0) * f.mx, (lat - lat0) * METERS_PER_DEG_LAT];
        const alt = (c: number[]) => terrain.elevation(c[0], c[1]) ?? 0;
        if (z.geometry.type === 'LineString') {
          // Tracé du parc : on le parcourt du haut vers le bas.
          const pts = alt(coords[0]) >= alt(coords[coords.length - 1]) ? coords : [...coords].reverse();
          layoutRun(out, f, pts.map(toXY), 26);
        } else {
          // Surface : on descend du point le plus haut du contour vers le plus bas.
          const [tx, ty] = toXY(coords.reduce((a, c) => (alt(c) > alt(a) ? c : a)));
          const [bx, by] = toXY(coords.reduce((a, c) => (alt(c) < alt(a) ? c : a)));
          const len = Math.hypot(bx - tx, by - ty);
          if (len < 30) continue;
          layoutArea(out, f, coords.map(toXY), [(bx - tx) / len, (by - ty) / len]);
        }
      }
      const source = map.getSource(PARK_FEATURES_LAYER) as GeoJSONSource | undefined;
      source?.setData({ type: 'FeatureCollection', features: out });
    })
    .catch(() => {
      // Relief indisponible : les parcs restent dessinés en surface, sans modules.
    });
}
