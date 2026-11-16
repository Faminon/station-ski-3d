// Sapins de la carte Three.js : le même sapin à trois étages que la carte MapLibre
// (forestInstanced.ts), répété par instanciation, planté par forestPlanting.ts (même
// grille, mêmes clairières le long des pistes et remontées). Une forêt instanciée par
// tuile du relief ; au loin, on ne dessine qu'une partie des arbres (les premiers par
// rang), sans rien refabriquer.

import * as THREE from 'three/webgpu';
import { attribute, color, instancedBufferAttribute, mix } from 'three/tsl';
import { GREENS, SNOW_CAP, TREE_INSTANCE_FLOATS, buildForestSet, plantTileInstances, setClearings, type Clearing } from '@/components/domain/forestPlanting';
import type { Elevation } from './elevation';
import { EXAGGERATION, type Frame } from './geo';
import type { Chunk } from './terrain';

/** Zoom des tuiles de plantation : un arbre tous les ~17 m. */
const PLANT_ZOOM = 15;

/** Étages : rayon (× largeur de l'arbre), bas, sommet (× hauteur), neige au sommet, rotation. */
const TIERS: [number, number, number, number, number][] = [
  [3.4, 0.04, 0.6, 0.3, 0],
  [2.5, 0.34, 0.83, 0.4, Math.PI / 6],
  [1.55, 0.58, 1.0, 0.95, 0],
];
const SEGMENTS = 6;

/** Sapin unité (x, z en largeurs d'arbre, y en hauteur) : faces planes, sommet enneigé. */
function treeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const snow: number[] = [];
  for (const [r, base, apex, cap, rot] of TIERS) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a0 = rot + (s / SEGMENTS) * Math.PI * 2;
      const a1 = rot + ((s + 1) / SEGMENTS) * Math.PI * 2;
      const top = new THREE.Vector3(0, apex, 0);
      const p0 = new THREE.Vector3(Math.cos(a0) * r, base, Math.sin(a0) * r);
      const p1 = new THREE.Vector3(Math.cos(a1) * r, base, Math.sin(a1) * r);
      // Normale de la face à l'échelle d'un arbre type (2,5 fois plus haut que large).
      const u = new THREE.Vector3(p0.x, (p0.y - apex) * 2.5, p0.z);
      const v = new THREE.Vector3(p1.x, (p1.y - apex) * 2.5, p1.z);
      const n = new THREE.Vector3().crossVectors(v, u).normalize();
      if (n.y < 0) n.negate();
      // Ordre top, p1, p0 : face avant tournée vers l'extérieur.
      for (const [p, w] of [
        [top, cap],
        [p1, 0],
        [p0, 0],
      ] as const) {
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        snow.push(w);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('snow', new THREE.Float32BufferAttribute(snow, 1));
  return g;
}

export interface ChunkForest {
  mesh: THREE.InstancedMesh;
  center: THREE.Vector3;
  /** Rangs triés : le nombre d'arbres à dessiner pour une densité donnée. */
  ranks: Float32Array;
}

export interface Forest {
  group: THREE.Group;
  chunks: ChunkForest[];
  total: number;
  /** Densité selon la distance à la caméra ; renvoie le nombre d'arbres dessinés. */
  update(camera: THREE.Camera, densityScale: number): number;
}

/** Part des arbres dessinés selon la distance (m) : au loin, quelques pixels et le brouillard. */
function densityAt(distance: number): number {
  if (distance < 3500) return 1;
  if (distance < 7000) return 0.6;
  if (distance < 11000) return 0.3;
  return 0;
}

export function buildForest(
  frame: Frame,
  elev: Elevation,
  forests: GeoJSON.FeatureCollection,
  clearings: Clearing[],
  chunks: Chunk[],
): Forest {
  const polygons: number[][][][] = [];
  for (const f of forests.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') polygons.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polygons.push(...g.coordinates);
  }
  const set = buildForestSet(polygons);
  setClearings(set, clearings);

  const geometry = treeGeometry();
  const greens = GREENS.map((c) => new THREE.Color(c));
  const group = new THREE.Group();
  const out: ChunkForest[] = [];
  let total = 0;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (const chunk of chunks) {
    const { z, x, y } = chunk.spec;
    const per = 2 ** (PLANT_ZOOM - z);
    const trees: { x: number; y: number; z: number; h: number; w: number; green: number; rank: number }[] = [];
    for (let i = 0; i < per; i++) {
      for (let j = 0; j < per; j++) {
        const tx = x * per + i;
        const ty = y * per + j;
        const { data, ranks } = plantTileInstances(set, PLANT_ZOOM, tx, ty);
        const n = 2 ** PLANT_ZOOM;
        for (let t = 0; t < ranks.length; t++) {
          const o = t * TREE_INSTANCE_FLOATS;
          const [wx, wz] = frame.mercToXZ(data[o] + tx / n, data[o + 1] + ty / n);
          trees.push({ x: wx, z: wz, y: elev.atOr0(wx, wz) * EXAGGERATION, h: data[o + 2], w: data[o + 3], green: data[o + 4], rank: ranks[t] });
        }
      }
    }
    if (!trees.length) continue;
    trees.sort((a, b) => a.rank - b.rank);

    const tint = new Float32Array(trees.length * 3);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    material.colorNode = mix(instancedBufferAttribute(new THREE.InstancedBufferAttribute(tint, 3), 'vec3'), color(SNOW_CAP), attribute('snow', 'float'));
    const mesh = new THREE.InstancedMesh(geometry, material, trees.length);
    const ranks = new Float32Array(trees.length);
    trees.forEach((t, i) => {
      // Les sapins s'enfoncent un peu : jamais de pied en l'air sur une pente.
      p.set(t.x, t.y - 1.5, t.z);
      s.set(t.w, t.h, t.w);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      const c = greens[t.green] ?? greens[0];
      tint.set([c.r, c.g, c.b], i * 3);
      ranks[i] = t.rank;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    group.add(mesh);
    out.push({ mesh, center: chunk.center, ranks });
    total += trees.length;
  }

  return {
    group,
    chunks: out,
    total,
    update(camera, densityScale) {
      let drawn = 0;
      for (const c of out) {
        const density = densityAt(camera.position.distanceTo(c.center)) * densityScale;
        // Premier rang ≥ densité : les arbres de rang inférieur sont dessinés.
        let lo = 0;
        let hi = c.ranks.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (c.ranks[mid] < density) lo = mid + 1;
          else hi = mid;
        }
        c.mesh.count = lo;
        c.mesh.visible = lo > 0;
        drawn += lo;
      }
      return drawn;
    },
  };
}
