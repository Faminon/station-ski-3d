// Relief de la carte Three.js : un maillage par tuile, photo aérienne IGN drapée,
// neige et barres rocheuses calculées par la carte graphique (TSL : le même code
// sert WebGPU et, à défaut, WebGL 2).
//
// Deux niveaux : tuiles 13 sur le domaine (maille fine, photos au zoom 15), tuiles 11
// autour pour l'horizon (maille large, photos au zoom 12), posées un peu plus bas pour
// passer sous les tuiles fines là où elles se recouvrent. Chaque tuile a une « jupe »
// verticale le long de ses bords, qui masque les fentes entre niveaux.
//
// En hiver, les forêts sont aussi peintes au sol (vert sombre) : vues de loin, là où les
// sapins 3D ne sont plus dessinés, elles restent lisibles, comme sur un plan des pistes.

import * as THREE from 'three/webgpu';
import { dot, float, mix, normalWorld, positionWorld, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import { fetchTile } from '@/lib/offlinePack';
import type { Elevation } from './elevation';
import { EXAGGERATION, mercX, mercY, type Frame } from './geo';

export interface ChunkSpec {
  z: number;
  x: number;
  y: number;
  /** Mailles par côté. */
  segments: number;
  /** Zoom des photos aériennes (≥ z) : 2^(textureZoom − z) photos par côté. */
  textureZoom: number;
  /** Abaissement (m), pour les tuiles de l'horizon. */
  drop: number;
}

/** 1 : hiver (neige, roche), 0 : photo d'été telle quelle. */
export const winter = uniform(1);

const SNOW = vec3(0.95, 0.97, 1.0);
/** Sous-bois enneigé vu de loin. */
const FOREST = vec3(0.13, 0.2, 0.16);
const MASK_SIZE = 512;
const SKIRT_M = 400;

/**
 * Matériau d'une tuile : photo provisoire grise, remplacée à son arrivée. Couleur du sol :
 * photo, grisée et enneigée selon l'altitude, roche à nu sur les pentes raides.
 */
function chunkMaterial(forestMask: THREE.Texture) {
  const placeholder = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255]), 1, 1);
  placeholder.needsUpdate = true;
  const photoNode = texture(placeholder);
  const forest = texture(forestMask).r.mul(winter).mul(0.7);
  const photo = photoNode.rgb;
  const gray = vec3(dot(photo, vec3(0.299, 0.587, 0.114)));
  // Altitude réelle (m) : le relief affiché est exagéré.
  const elev = positionWorld.y.div(EXAGGERATION);
  // Neige jusqu'en fond de vallée, de plus en plus pure en montant (comme la carte MapLibre).
  const snow = smoothstep(400, 2100, elev).mul(0.75).add(0.25).mul(winter);
  // Pente au-delà de ~30-40° (réels ; la normale vient du relief exagéré) en altitude : roche.
  const steep = float(1).sub(smoothstep(0.705, 0.822, normalWorld.y));
  const rock = steep.mul(smoothstep(1750, 2050, elev)).mul(winter);
  const base = mix(mix(photo, gray.mul(0.9), winter), SNOW, snow);
  // Deux faces : la jupe est vue d'un côté ou de l'autre selon le bord.
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  // Forêt : vert sombre texturé par la photo (cimes, trouées), poudré de neige.
  const woods = mix(FOREST, photo.mul(0.75), 0.45).add(gray.mul(0.12));
  material.colorNode = mix(mix(base, gray.mul(vec3(1.04, 1.0, 0.95)), rock), woods, forest);
  return { material, photo: photoNode };
}

/** Forêts de la tuile peintes en blanc sur noir (canal rouge), un peu adoucies. */
function forestMask(spec: ChunkSpec, polygons: number[][][][]): THREE.Texture {
  const canvas = new OffscreenCanvas(MASK_SIZE, MASK_SIZE);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
  const n = 2 ** spec.z;
  const px = (lng: number) => (mercX(lng) * n - spec.x) * MASK_SIZE;
  const py = (lat: number) => (mercY(lat) * n - spec.y) * MASK_SIZE;
  ctx.filter = 'blur(1px)';
  ctx.fillStyle = '#fff';
  for (const rings of polygons) {
    const outer = rings[0];
    let inside = false;
    for (const [lng, lat] of outer) {
      const x = px(lng);
      const y = py(lat);
      if (x > -MASK_SIZE && x < 2 * MASK_SIZE && y > -MASK_SIZE && y < 2 * MASK_SIZE) {
        inside = true;
        break;
      }
    }
    if (!inside) continue;
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([lng, lat], i) => (i ? ctx.lineTo(px(lng), py(lat)) : ctx.moveTo(px(lng), py(lat))));
      ctx.closePath();
    }
    // Anneaux intérieurs (clairières) : règle pair-impair.
    ctx.fill('evenodd');
  }
  const tex = new THREE.Texture(canvas.transferToImageBitmap());
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** Maillage d'une tuile : grille, normales tirées du relief (continues d'une tuile à l'autre), jupe. */
function chunkGeometry(frame: Frame, elev: Elevation, spec: ChunkSpec): THREE.BufferGeometry {
  const [x0, z0, x1, z1] = frame.tileRect(spec.z, spec.x, spec.y);
  const S = spec.segments;
  const side = S + 1;
  const step = (x1 - x0) / S;
  const height = (x: number, z: number) => elev.atOr0(x, z) * EXAGGERATION - spec.drop;

  const gridCount = side * side;
  const skirtCount = 4 * side;
  const positions = new Float32Array((gridCount + skirtCount) * 3);
  const normals = new Float32Array((gridCount + skirtCount) * 3);
  const uvs = new Float32Array((gridCount + skirtCount) * 2);

  for (let j = 0; j <= S; j++) {
    for (let i = 0; i <= S; i++) {
      const k = j * side + i;
      const x = x0 + i * step;
      const z = z0 + (j * (z1 - z0)) / S;
      positions[k * 3] = x;
      positions[k * 3 + 1] = height(x, z);
      positions[k * 3 + 2] = z;
      // Normale par différences centrées, lues dans le relief (y compris hors de la tuile).
      const dx = (height(x + step, z) - height(x - step, z)) / (2 * step);
      const dz = (height(x, z + step) - height(x, z - step)) / (2 * step);
      const l = Math.hypot(dx, 1, dz);
      normals[k * 3] = -dx / l;
      normals[k * 3 + 1] = 1 / l;
      normals[k * 3 + 2] = -dz / l;
      uvs[k * 2] = i / S;
      uvs[k * 2 + 1] = j / S;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Jupe : copie de chaque bord, descendue de SKIRT_M, reliée au bord.
  const edges: number[][] = [
    Array.from({ length: side }, (_, i) => i), // nord
    Array.from({ length: side }, (_, i) => S * side + i), // sud
    Array.from({ length: side }, (_, j) => j * side), // ouest
    Array.from({ length: side }, (_, j) => j * side + S), // est
  ];
  let next = gridCount;
  edges.forEach((edge, e) => {
    const start = next;
    for (const k of edge) {
      positions.set([positions[k * 3], positions[k * 3 + 1] - SKIRT_M, positions[k * 3 + 2]], next * 3);
      normals.set([normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]], next * 3);
      uvs.set([uvs[k * 2], uvs[k * 2 + 1]], next * 2);
      next++;
    }
    for (let t = 0; t < S; t++) {
      const a = edge[t];
      const b = edge[t + 1];
      const c = start + t;
      const d = start + t + 1;
      // Deux faces : la jupe se voit des deux côtés selon le bord.
      if (e === 0 || e === 3) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Photo aérienne de la tuile : 2^(textureZoom − z) photos IGN par côté, assemblées. */
async function chunkPhoto(spec: ChunkSpec, maxAnisotropy: number, signal: AbortSignal): Promise<THREE.Texture | null> {
  const count = 2 ** (spec.textureZoom - spec.z);
  const canvas = new OffscreenCanvas(256 * count, 256 * count);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#969696';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const x0 = spec.x * count;
  const y0 = spec.y * count;
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      jobs.push(
        fetchTile('ortho', spec.textureZoom, x0 + i, y0 + j, signal)
          .then((blob) => createImageBitmap(blob))
          .then((bitmap) => {
            ctx.drawImage(bitmap, i * 256, j * 256);
            bitmap.close();
          })
          .catch(() => undefined),
      );
    }
  }
  await Promise.all(jobs);
  if (signal.aborted) return null;
  const tex = new THREE.Texture(canvas.transferToImageBitmap());
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface Chunk {
  spec: ChunkSpec;
  mesh: THREE.Mesh;
  /** Centre (m), pour le niveau de détail des sapins. */
  center: THREE.Vector3;
  loadPhoto(signal: AbortSignal): Promise<void>;
}

export function buildChunk(frame: Frame, elev: Elevation, spec: ChunkSpec, maxAnisotropy: number, forests: number[][][][]): Chunk {
  const geometry = chunkGeometry(frame, elev, spec);
  const { material, photo } = chunkMaterial(forestMask(spec, forests));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  const [x0, z0, x1, z1] = frame.tileRect(spec.z, spec.x, spec.y);
  const center = new THREE.Vector3((x0 + x1) / 2, geometry.boundingSphere!.center.y, (z0 + z1) / 2);
  return {
    spec,
    mesh,
    center,
    async loadPhoto(signal) {
      const tex = await chunkPhoto(spec, maxAnisotropy, signal);
      if (!tex) return;
      const old = photo.value;
      photo.value = tex;
      old.dispose();
    },
  };
}
