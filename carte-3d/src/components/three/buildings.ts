// Bâtiments et équipements 3D de la carte Three.js : les mêmes volumes que la carte MapLibre,
// extrudés ici en un seul maillage par ensemble (couleurs par sommet, un appel de dessin).
//
// - Lieux du domaine : chalets des restaurants, refuges, toilettes, secours, belvédères…
//   (mountainBuildings.ts), un maillage par catégorie pour suivre les cases du panneau.
// - Remontées : gares, pylônes et câbles (liftAnimation.ts) ; véhicules animés, instanciés
//   (un pavé par pièce : suspente, siège, cabine…), repositionnés à chaque image.
// - Villages : bâtiments réels d'OpenStreetMap (/data/villages/<id>.json).
//
// Comme sur la carte MapLibre, lieux et remontées grossissent quand on s'éloigne (échelle `k`)
// et disparaissent de loin ; un volume est posé au sol sous son centre (bas `b`, haut `h`), un
// bâtiment de village sur le point le plus bas de son contour (jamais en l'air sur une pente).

import * as THREE from 'three/webgpu';
import type { DomainPoi } from '@/lib/domainPois';
import type { Village3d } from '@/lib/village3d';
import { placeVolumes } from '@/components/domain/mountainBuildings';
import { liftVehicleBoxes, liftVolumes, type LiftLine } from '@/components/station/liftAnimation';
import { facadeColor } from '@/components/station/facade';
import type { TrackLine } from './domainData';
import type { Elevation } from './elevation';
import { EXAGGERATION, type Frame } from './geo';

/** Volume à extruder : contour [lng, lat], bas et haut (m) au-dessus du sol, couleur. */
interface Prism {
  ring: number[][];
  base: number;
  top: number;
  color: string;
}

const material = () => new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });

/**
 * Extrude des volumes en un maillage : murs et toit, normales nettes. `seat` : sol sous le
 * centre du volume (« center ») ou sous le point le plus bas de son contour (« min »).
 */
function extrude(prisms: Prism[], frame: Frame, elev: Elevation, seat: 'center' | 'min'): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const ground = (x: number, z: number) => elev.atOr0(x, z) * EXAGGERATION;

  /** Triangle tourné vers `want` (normale voulue), avec cette normale. */
  const tri = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3, want: THREE.Vector3) => {
    e1.subVectors(b, a);
    e2.subVectors(d, a);
    n.crossVectors(e1, e2);
    const [p, q] = n.dot(want) >= 0 ? [b, d] : [d, b];
    for (const v of [a, p, q]) {
      pos.push(v.x, v.y, v.z);
      nor.push(want.x, want.y, want.z);
      col.push(c.r, c.g, c.b);
    }
  };

  const up = new THREE.Vector3(0, 1, 0);
  const out = new THREE.Vector3();
  for (const prism of prisms) {
    const ring = prism.ring.slice();
    // Contour fermé : le dernier point répète le premier.
    const last = ring[ring.length - 1];
    if (ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1]) ring.pop();
    if (ring.length < 3) continue;
    const pts = ring.map(([lng, lat]) => frame.toXZ(lng, lat));
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const g = seat === 'center' ? ground(cx, cz) : Math.min(...pts.map(([x, z]) => ground(x, z)));
    const y0 = g + prism.base;
    const y1 = g + prism.top;
    if (y1 <= y0) continue;
    c.set(prism.color);

    // Murs : chaque côté, tourné vers l'extérieur du contour.
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % pts.length];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      out.set(dz / len, 0, -dx / len);
      if (out.x * ((ax + bx) / 2 - cx) + out.z * ((az + bz) / 2 - cz) < 0) out.negate();
      v0.set(ax, y0, az);
      v1.set(bx, y0, bz);
      v2.set(bx, y1, bz);
      tri(v0, v1, v2, out);
      v1.set(ax, y1, az);
      tri(v0, v2, v1, out);
    }
    // Toit plat (les toits à pans sont des volumes empilés, comme sur la carte MapLibre).
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    for (const [a, b, d] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      v0.set(pts[a][0], y1, pts[a][1]);
      v1.set(pts[b][0], y1, pts[b][1]);
      v2.set(pts[d][0], y1, pts[d][1]);
      tri(v0, v1, v2, up);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

const toPrisms = (features: { geometry: { coordinates: number[][][] }; properties: { c: string; b: number; h: number } }[]): Prism[] =>
  features.map((f) => ({ ring: f.geometry.coordinates[0], base: f.properties.b, top: f.properties.h, color: f.properties.c }));

/** Volumes quelconques (contour, couleur `c`, bas `b`, haut `h`) en un maillage : modules des snowparks. */
export function buildVolumeMesh(frame: Frame, elev: Elevation, features: { geometry: { coordinates: number[][][] }; properties: { c: string; b: number; h: number } }[]): THREE.Mesh {
  return new THREE.Mesh(extrude(toPrisms(features), frame, elev, 'center'), material());
}

/** Lieux modélisés, un maillage par catégorie. */
export function buildPlaceMeshes(frame: Frame, elev: Elevation, places: DomainPoi[], k: number): Map<string, THREE.Mesh> {
  const byCategory = new Map<string, Prism[]>();
  for (const v of placeVolumes(places, k)) {
    const list = byCategory.get(v.properties.cat) ?? [];
    list.push(...toPrisms([v]));
    byCategory.set(v.properties.cat, list);
  }
  const meshes = new Map<string, THREE.Mesh>();
  for (const [cat, prisms] of byCategory) meshes.set(cat, new THREE.Mesh(extrude(prisms, frame, elev, 'center'), material()));
  return meshes;
}

const liftLines = (lifts: TrackLine[]): LiftLine[] => lifts.map((l) => ({ name: l.name, liftType: l.detail, coordinates: l.coordinates }));

/** Remontées : gares, pylônes et câbles, en un seul maillage (les véhicules sont à part, animés). */
export function buildLiftMesh(frame: Frame, elev: Elevation, lifts: TrackLine[], k: number): THREE.Mesh {
  const ground = (lng: number, lat: number) => {
    const [x, z] = frame.toXZ(lng, lat);
    return elev.atOr0(x, z) * EXAGGERATION;
  };
  const { structures } = liftVolumes(liftLines(lifts), k, ground);
  return new THREE.Mesh(extrude(toPrisms(structures), frame, elev, 'center'), material());
}

/** Vitesse du câble (m/s) selon le type de remontée : celles d'un vrai domaine, à peu près. */
const CABLE_SPEED: Record<string, number> = {
  chair_lift: 5,
  gondola: 6,
  mixed_lift: 5.5,
  cable_car: 10,
  funicular: 8,
  platter: 3.5,
  drag_lift: 3.5,
  't-bar': 3.5,
  'j-bar': 3.5,
  rope_tow: 2.5,
};

export interface LiftVehicles {
  mesh: THREE.InstancedMesh;
  /**
   * Place les véhicules à l'instant `seconds`, à l'échelle `k` ; les remontées fermées
   * (identifiants OpenStreetMap) restent immobiles.
   */
  update(seconds: number, k: number, closed: Set<number>): void;
}

/** Véhicules des remontées : pavés instanciés, une seule géométrie et un seul appel de dessin. */
export function buildLiftVehicles(frame: Frame, elev: Elevation, lifts: TrackLine[]): LiftVehicles {
  const lines = liftLines(lifts);
  // Capacité : le plus de pavés possible, à l'échelle 1 (véhicules les plus serrés).
  let capacity = 0;
  liftVehicleBoxes(lines, 1, () => 0, () => capacity++);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 }), Math.max(1, capacity));
  mesh.count = 0;
  // Les véhicules bougent : pas de calcul d'emprise (elle serait fausse une image sur deux).
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const colors = new Map<string, THREE.Color>();
  const colorOf = (hex: string) => {
    let c = colors.get(hex);
    if (!c) colors.set(hex, (c = new THREE.Color(hex)));
    return c;
  };

  return {
    mesh,
    update(seconds, k, closed) {
      let i = 0;
      liftVehicleBoxes(
        lines,
        k,
        (index) => (closed.has(lifts[index].osmId) ? 0 : seconds * (CABLE_SPEED[lifts[index].detail] ?? 5)),
        (lng, lat, ux, uy, along, across, b, h, c) => {
          if (i >= capacity) return;
          const [x, z] = frame.toXZ(lng, lat);
          const g = elev.atOr0(x, z) * EXAGGERATION;
          // Grand axe dans le sens de la montée : (est, nord) → (x, −z) dans la scène.
          q.setFromAxisAngle(yAxis, Math.atan2(uy, ux));
          p.set(x, g + (b + h) / 2, z);
          s.set(2 * along, Math.max(0.05, h - b), 2 * across);
          m.compose(p, q, s);
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, colorOf(c));
          i++;
        },
      );
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

/** Bâtiments réels des villages (chargés à la demande). */
export async function loadVillageMesh(frame: Frame, elev: Elevation, villageIds: string[]): Promise<THREE.Mesh | null> {
  const villages = await Promise.all(
    villageIds.map((id) =>
      fetch(`/data/villages/${encodeURIComponent(id)}.json`)
        .then((r): Promise<Village3d> | null => (r.ok ? r.json() : null))
        .catch(() => null),
    ),
  );
  const prisms: Prism[] = villages.flatMap((v) =>
    (v?.buildings ?? []).map((b) => ({ ring: b.ring, base: 0, top: b.h, color: facadeColor(b.ring as [number, number][]) })),
  );
  if (!prisms.length) return null;
  return new THREE.Mesh(extrude(prisms, frame, elev, 'min'), material());
}
