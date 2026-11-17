// Sapins de la carte Three.js : le même sapin à trois étages que la carte MapLibre
// (forestInstanced.ts), répété par instanciation, planté par forestPlanting.ts (même
// grille, mêmes clairières le long des pistes et remontées) dans le worker du relief.
// Une forêt instanciée par tuile du relief ; au loin, on ne dessine qu'une partie des
// arbres (les premiers par rang), sans rien refabriquer.

import * as THREE from 'three/webgpu';
import { attribute, color, mix } from 'three/tsl';
import { GREENS, SNOW_CAP } from '@/components/domain/forestPlanting';
import type { Elevation } from './elevation';
import { EXAGGERATION, type Frame } from './geo';
import type { Chunk } from './terrain';
import { TREE_FLOATS } from './terrainWorker';

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
  /**
   * Sapins d'une tuile du relief (plantés par le worker, voir terrainWorker.ts) : renvoie le
   * maillage à ajouter (à `group`), ou null sans arbre.
   */
  plant(chunk: Chunk, trees: Float32Array): THREE.InstancedMesh | null;
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

/**
 * Forêt vide, garnie tuile par tuile (`plant`) une fois la carte affichée. Un seul matériau pour
 * toutes les tuiles (teinte de chaque arbre portée par la géométrie) : un seul programme de
 * dessin à préparer, quel que soit le nombre de tuiles.
 */
export function createForest(frame: Frame, elev: Elevation): Forest {
  const base = treeGeometry();
  const greens = GREENS.map((c) => new THREE.Color(c));
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  material.colorNode = mix(attribute('tint', 'vec3'), color(SNOW_CAP), attribute('snow', 'float'));
  const group = new THREE.Group();
  const out: ChunkForest[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();

  const forest: Forest = {
    group,
    chunks: out,
    total: 0,
    plant(chunk, trees) {
      const count = trees.length / TREE_FLOATS;
      if (!count) return null;
      const { z, x, y } = chunk.spec;
      const n = 2 ** z;
      const geometry = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'snow']) geometry.setAttribute(name, base.getAttribute(name));
      const tint = new Float32Array(count * 3);
      geometry.setAttribute('tint', new THREE.InstancedBufferAttribute(tint, 3));
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      const ranks = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const o = i * TREE_FLOATS;
        const [wx, wz] = frame.mercToXZ(x / n + trees[o], y / n + trees[o + 1]);
        // Les sapins s'enfoncent un peu : jamais de pied en l'air sur une pente.
        p.set(wx, elev.atOr0(wx, wz) * EXAGGERATION - 1.5, wz);
        s.set(trees[o + 3], trees[o + 2], trees[o + 3]);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        const c = greens[trees[o + 4]] ?? greens[0];
        tint[i * 3] = c.r;
        tint[i * 3 + 1] = c.g;
        tint[i * 3 + 2] = c.b;
        ranks[i] = trees[o + 5];
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
      // Pas encore dessiné : la prochaine mise à jour de la densité en décide.
      mesh.count = 0;
      mesh.visible = false;
      out.push({ mesh, center: chunk.center, ranks });
      forest.total += count;
      return mesh;
    },
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
  return forest;
}
