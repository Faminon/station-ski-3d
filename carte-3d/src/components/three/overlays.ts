// Pistes, remontées et sommets de la carte Three.js. Les tracés sont des traits d'épaisseur
// constante à l'écran (comme sur un plan des pistes), posés quelques mètres au-dessus du
// relief ; un seul objet pour toutes les pistes, un pour les remontées, avec une couleur par
// tracé : une piste fermée (conditions en direct) est estompée sans rien reconstruire. Les
// noms des sommets sont des étiquettes HTML (CSS2DRenderer).

import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { PISTE_COLORS, type PisteDifficulty, type StationPisteMap } from '@/lib/apis/overpass';
import type { TrackLine } from './domainData';
import type { Elevation } from './elevation';
import { EXAGGERATION, type Frame } from './geo';

const METERS_PER_DEG_LAT = 110_574;
/** Pas de pose des tracés sur le relief (m). */
const STEP_M = 15;
/** Hauteur des tracés au-dessus du sol (m) : assez pour ne pas passer sous les mailles du relief. */
const LIFT_OFF_M = 6;
export const LIFT_COLOR = '#2b2f36';
/** Tracé fermé : couleur mêlée de blanc (même effet que l'opacité réduite de la carte MapLibre). */
const CLOSED_FADE = 0.55;

/** Plan des pistes (mètres autour de son centre, y vers le sud) → longitude, latitude. */
export function pisteLngLat(map: StationPisteMap) {
  const { lat, lng } = map.center;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  return (p: { x: number; y: number }): [number, number] => [lng + p.x / mPerDegLng, lat - p.y / METERS_PER_DEG_LAT];
}

type Ground = (x: number, z: number) => number;

/** Segments d'un tracé posé sur le relief : [x, y, z] de chaque extrémité, à la suite. */
function drape(points: [number, number][], ground: Ground, out: number[]) {
  let prev: [number, number, number] | null = null;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP_M));
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const z = az + ((bz - az) * s) / steps;
      const p: [number, number, number] = [x, ground(x, z) + LIFT_OFF_M, z];
      if (prev) out.push(...prev, ...p);
      prev = p;
    }
  }
}

export const trackColor = (t: TrackLine) => (t.kind === 'lift' ? LIFT_COLOR : (PISTE_COLORS[t.detail as PisteDifficulty] ?? PISTE_COLORS.unknown));

/** Un ensemble de tracés : positions, et pour chaque tracé, ses segments (début, fin). */
interface TrackSet {
  mesh: LineSegments2;
  casing: LineSegments2;
  geometry: LineSegmentsGeometry;
  ranges: [number, number][];
  tracks: TrackLine[];
}

/**
 * Tracés d'un ensemble, avec leur liseré blanc translucide (comme la carte MapLibre : sans lui,
 * des couleurs pures et non éclairées sur la neige ombrée paraissent fluorescentes).
 */
function buildSet(tracks: TrackLine[], toXZ: (c: number[]) => [number, number], ground: Ground, width: number, casingOpacity: number): TrackSet {
  const positions: number[] = [];
  const ranges: [number, number][] = [];
  for (const t of tracks) {
    const start = positions.length;
    const pts = t.coordinates.map(toXZ);
    // Remontées comme pistes : trait au sol ; câbles, pylônes et gares en 3D (buildings.ts).
    if (pts.length >= 2) drape(pts, ground, positions);
    ranges.push([start, positions.length]);
  }
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  // `transparent` : trait et liseré dans la même passe (Three dessine toujours les objets
  // translucides après les opaques), où `renderOrder` met le liseré dessous.
  const material = new THREE.Line2NodeMaterial({ color: '#ffffff', linewidth: width, worldUnits: false, vertexColors: true, transparent: true });
  const mesh = new LineSegments2(geometry, material);
  // Dessinés après le relief, le liseré d'abord (sans écrire la profondeur : il ne masque pas le trait).
  mesh.renderOrder = 1;
  const casing = new LineSegments2(
    geometry,
    new THREE.Line2NodeMaterial({ color: '#ffffff', linewidth: width + 2.2, worldUnits: false, transparent: true, opacity: casingOpacity, depthWrite: false }),
  );
  casing.renderOrder = 0.5;
  const set = { mesh, casing, geometry, ranges, tracks };
  paint(set, () => false);
  return set;
}

/**
 * Couleur de chaque tracé, estompée s'il est fermé ; tout en gris pâle pendant le guidage.
 * Les mélanges se font en sRGB, comme l'opacité de la carte MapLibre (en linéaire, le blanc
 * l'emporte trop vite et donne des teintes pastel criardes).
 */
function paint(set: TrackSet, closed: (t: TrackLine) => boolean, faded = false) {
  const total = set.ranges.length ? set.ranges[set.ranges.length - 1][1] : 0;
  const colors = new Float32Array(total);
  const c = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  set.tracks.forEach((t, i) => {
    c.set(faded ? '#9aa1a8' : trackColor(t)).convertLinearToSRGB();
    // Teintes un peu adoucies : le trait n'est pas éclairé, le relief si.
    if (!faded) c.offsetHSL(0, -0.08, -0.03);
    if (faded) c.lerp(white, 0.45);
    else if (closed(t)) c.lerp(white, CLOSED_FADE);
    c.convertSRGBToLinear();
    const [a, b] = set.ranges[i];
    for (let k = a; k < b; k += 3) colors.set([c.r, c.g, c.b], k);
  });
  set.geometry.setColors(colors);
}

export interface TrackLayer {
  group: THREE.Group;
  /** Tracés fermés selon les conditions en direct (identifiants OpenStreetMap). */
  setClosed(pistes: Set<number>, lifts: Set<number>): void;
  /** Met des tracés en évidence (piste ou remontée choisie), ou rien. */
  setHighlight(tracks: TrackLine[] | null): void;
  /** Guidage : tout le domaine grisé, seul l'itinéraire reste net. */
  setFaded(faded: boolean): void;
}

export function buildTrackLayer(frame: Frame, elev: Elevation, tracks: { pistes: TrackLine[]; lifts: TrackLine[] }): TrackLayer {
  const toXZ = (c: number[]) => frame.toXZ(c[0], c[1]);
  const ground = (x: number, z: number) => elev.atOr0(x, z) * EXAGGERATION;
  const group = new THREE.Group();
  // Mêmes proportions que la carte MapLibre : liseré marqué pour les pistes, discret pour les remontées.
  const pistes = buildSet(tracks.pistes, toXZ, ground, 2.6, 0.75);
  const lifts = buildSet(tracks.lifts, toXZ, ground, 1.8, 0.35);
  group.add(pistes.casing, pistes.mesh, lifts.casing, lifts.mesh);

  let highlight: THREE.Object3D[] = [];
  let closedPistes = new Set<number>();
  let closedLifts = new Set<number>();
  let faded = false;
  const repaint = () => {
    paint(pistes, (t) => closedPistes.has(t.osmId), faded);
    paint(lifts, (t) => closedLifts.has(t.osmId), faded);
  };
  return {
    group,
    setClosed(p, l) {
      closedPistes = p;
      closedLifts = l;
      repaint();
    },
    setFaded(on) {
      faded = on;
      repaint();
    },
    setHighlight(list) {
      for (const o of highlight) {
        group.remove(o);
        const m = o as LineSegments2;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      highlight = [];
      if (!list?.length) return;
      const positions: number[] = [];
      for (const t of list) {
        const pts = t.coordinates.map(toXZ);
        if (pts.length >= 2) drape(pts, ground, positions);
      }
      // Liseré blanc, puis le tracé épaissi dans sa couleur.
      for (const [color, width, order] of [
        ['#ffffff', 10, 2],
        [trackColor(list[0]), 6, 3],
      ] as const) {
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        const mesh = new LineSegments2(geometry, new THREE.Line2NodeMaterial({ color, linewidth: width, worldUnits: false, depthWrite: order === 3 }));
        mesh.renderOrder = order;
        group.add(mesh);
        highlight.push(mesh);
      }
    },
  };
}

// ---- Itinéraire ---------------------------------------------------------------------------

/** Couleurs de l'itinéraire, comme sur la carte MapLibre : aperçu (pistes en orange) ou guidage. */
const ROUTE_PREVIEW = { piste: '#ff6b00', lift: '#7048e8', walk: '#868e96' };
const ROUTE_GUIDE = { lift: '#fab005', walk: '#4dabf7' };

export interface RouteStepLine {
  kind: 'piste' | 'lift' | 'walk';
  detail: string;
  coordinates: number[][];
}

export interface RouteLayer {
  group: THREE.Group;
  set(steps: RouteStepLine[] | null, guiding: boolean): void;
}

/** Itinéraire : liseré blanc puis trait coloré par étape, au-dessus des tracés du domaine. */
export function buildRouteLayer(frame: Frame, elev: Elevation): RouteLayer {
  const toXZ = (c: number[]) => frame.toXZ(c[0], c[1]);
  // Un peu plus haut que les pistes : l'itinéraire passe devant elles.
  const ground = (x: number, z: number) => elev.atOr0(x, z) * EXAGGERATION + 3;
  const group = new THREE.Group();
  return {
    group,
    set(steps, guiding) {
      for (const o of [...group.children]) {
        group.remove(o);
        const m = o as LineSegments2;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      if (!steps?.length) return;
      const positions: number[] = [];
      const colors: number[] = [];
      const c = new THREE.Color();
      for (const s of steps) {
        const start = positions.length;
        const pts = s.coordinates.map(toXZ);
        if (pts.length < 2) continue;
        drape(pts, ground, positions);
        c.set(
          guiding
            ? s.kind === 'piste'
              ? (PISTE_COLORS[s.detail as PisteDifficulty] ?? PISTE_COLORS.unknown)
              : ROUTE_GUIDE[s.kind]
            : ROUTE_PREVIEW[s.kind],
        );
        for (let k = start; k < positions.length; k += 3) colors.push(c.r, c.g, c.b);
      }
      const casing = new LineSegmentsGeometry();
      casing.setPositions(positions);
      // Toujours visible, même quand une bosse du relief passe devant (comme un GPS de voiture) :
      // ni test ni écriture de profondeur, dessiné après le reste.
      const casingMesh = new LineSegments2(casing, new THREE.Line2NodeMaterial({ color: '#ffffff', linewidth: guiding ? 12 : 9, worldUnits: false, depthTest: false, depthWrite: false }));
      casingMesh.renderOrder = 4;
      const line = new LineSegmentsGeometry();
      line.setPositions(positions);
      line.setColors(colors);
      const lineMesh = new LineSegments2(line, new THREE.Line2NodeMaterial({ color: '#ffffff', linewidth: guiding ? 7 : 5, worldUnits: false, vertexColors: true, depthTest: false, depthWrite: false }));
      lineMesh.renderOrder = 5;
      group.add(casingMesh, lineMesh);
    },
  };
}

/** Étiquettes des sommets nommés. */
export function buildPeakLabels(frame: Frame, elev: Elevation, map: StationPisteMap): THREE.Group {
  const toLngLat = pisteLngLat(map);
  const group = new THREE.Group();
  for (const peak of map.peaks) {
    if (!peak.name) continue;
    const [x, z] = frame.toXZ(...toLngLat(peak.point));
    const el = document.createElement('div');
    el.className = 'three-peak';
    el.textContent = `${peak.name}${peak.elevation ? ` · ${peak.elevation} m` : ''}`;
    const label = new CSS2DObject(el);
    label.position.set(x, elev.atOr0(x, z) * EXAGGERATION + 30, z);
    label.center.set(0.5, 1);
    group.add(label);
  }
  return group;
}

// ---- Routes ------------------------------------------------------------------------------

/** Routes par classe, comme la carte MapLibre : couleur, épaisseur (px) ; liseré crème. */
const ROAD_STYLE: Record<string, { color: string; width: number }> = {
  major: { color: '#7c6a58', width: 2.6 },
  road: { color: '#8f8478', width: 2 },
  street: { color: '#a39d95', width: 1.5 },
};

export interface RoadLayer {
  group: THREE.Group;
  /** Rues des villages : seulement de près (la carte MapLibre les montre dès le zoom 12,5). */
  streets: THREE.Object3D[];
  /** Numéros des grandes routes (D902…) : un point par tronçon assez long. */
  refs: { lng: number; lat: number; ref: string }[];
}

/** Routes posées sur le relief, sous les pistes (même ordre de dessin que la carte MapLibre). */
export function buildRoadLayer(frame: Frame, elev: Elevation, roads: GeoJSON.FeatureCollection): RoadLayer {
  const toXZ = (c: number[]) => frame.toXZ(c[0], c[1]);
  const ground = (x: number, z: number) => elev.atOr0(x, z) * EXAGGERATION;
  const byClass = new Map<string, number[]>();
  const refs: RoadLayer['refs'] = [];
  const lastRef = new Map<string, [number, number]>();
  for (const f of roads.features) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
    const cls = String(f.properties?.cls ?? 'road');
    const list = byClass.get(cls) ?? [];
    for (const coords of lines) {
      if (coords.length >= 2) drape(coords.map(toXZ), ground, list);
      // Numéro de route : au milieu du tronçon, pas plus d'un tous les 3 km pour le même numéro.
      const ref = f.properties?.ref;
      if (ref && coords.length >= 2) {
        const [lng, lat] = coords[Math.floor(coords.length / 2)];
        const prev = lastRef.get(ref);
        if (!prev || Math.hypot((prev[0] - lng) * 79_000, (prev[1] - lat) * 111_000) > 3000) {
          refs.push({ lng, lat, ref: String(ref) });
          lastRef.set(ref, [lng, lat]);
        }
      }
    }
    byClass.set(cls, list);
  }
  const group = new THREE.Group();
  const streets: THREE.Object3D[] = [];
  for (const [cls, positions] of byClass) {
    if (!positions.length) continue;
    const style = ROAD_STYLE[cls] ?? ROAD_STYLE.road;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const casing = new LineSegments2(
      geometry,
      new THREE.Line2NodeMaterial({ color: '#fdfbf7', linewidth: style.width + 2, worldUnits: false, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    casing.renderOrder = 0.2;
    const line = new LineSegments2(geometry, new THREE.Line2NodeMaterial({ color: style.color, linewidth: style.width, worldUnits: false, transparent: true }));
    line.renderOrder = 0.3;
    group.add(casing, line);
    if (cls === 'street') streets.push(casing, line);
  }
  return { group, streets, refs };
}
