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
import { clamp, color, dot, float, materialReference, mix, normalWorld, positionWorld, pow, smoothstep, transformNormalToView, uniform, vec3, vec4 } from 'three/tsl';
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
  /**
   * Zone couverte par un niveau plus fin [x0, z0, x1, z1] (m) : les mailles qui y tombent entièrement
   * ne sont pas dessinées. Sans cela, le maillage grossier, tendu d'une crête à l'autre, passait
   * au-dessus du fond des vallées détaillées et les recouvrait d'une nappe plate.
   */
  exclude?: [number, number, number, number];
}

/** Zoom des altitudes du domaine : les normales par pixel en sont tirées (~7 m par pixel). */
export const DEM_ZOOM = 14;

/** 1 : hiver (neige, roche), 0 : photo d'été telle quelle. */
export const winter = uniform(1);
/** 1 : zones de snowpark et zones ludiques peintes sur le relief (case « Snowparks »), 0 : masquées. */
export const parksShown = uniform(1);
/** Couleurs des parcs (mêmes que la carte MapLibre, parkZones.ts). */
const PARK_ORANGE = color('#f76707');
const PARK_YELLOW = color('#fab005');

/** Côté (px) de la texture des parcs d'une tuile : ~1,7 m par pixel en z13, contours nets. */
export const PARK_OVERLAY_SIZE = 2048;
/** Couche de couverture des parcs d'une tuile (voir parks.ts), ou null. */
export type OverlayPainter = (z: number, x: number, y: number, metersPerPixel: number) => THREE.Texture | null;

const SNOW = vec3(0.95, 0.97, 1.0);
/** Sous-bois enneigé vu de loin. */
const FOREST = vec3(0.13, 0.2, 0.16);
const MASK_SIZE = 512;
const SKIRT_M = 400;

/** Photo provisoire grise, la même pour toutes les tuiles (filtrage identique à celui des photos). */
const PLACEHOLDER = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255]), 1, 1);
PLACEHOLDER.magFilter = THREE.LinearFilter;
PLACEHOLDER.minFilter = THREE.LinearMipmapLinearFilter;
PLACEHOLDER.generateMipmaps = true;
PLACEHOLDER.needsUpdate = true;

/** Textures propres à chaque tuile, lues dans son matériau par les nœuds partagés (terrainNodes). */
interface ChunkMaps {
  photoMap: THREE.Texture;
  forestMap: THREE.Texture;
  slopeMap?: THREE.Texture;
  parkMap?: THREE.Texture;
}

/**
 * Couleur et normale du sol : photo, grisée et enneigée selon l'altitude, roche à nu sur les pentes
 * raides. Un seul graphe de nœuds par variante (pentes par pixel ou non, parcs ou non), partagé
 * par toutes les tuiles : chaque tuile n'apporte que ses textures (propriétés de son matériau,
 * voir ChunkMaps). Un graphe par tuile obligeait à préparer un programme de dessin par tuile
 * (une centaine), plusieurs secondes au lancement de la carte.
 */
type ColorNode = NonNullable<THREE.MeshStandardNodeMaterial['colorNode']>;
type NormalNode = NonNullable<THREE.MeshStandardNodeMaterial['normalNode']>;
const graphs = new Map<string, { color: ColorNode; normal: NormalNode | null }>();
/** Texture lue dans la propriété `name` du matériau dessiné. */
const mapOf = (name: keyof ChunkMaps) => materialReference(name, 'texture') as unknown as ReturnType<typeof vec4>;
function terrainNodes(withSlopes: boolean, withParks: boolean) {
  const key = `${withSlopes}/${withParks}`;
  const cached = graphs.get(key);
  if (cached) return cached;
  const photo = mapOf('photoMap').rgb;
  const forest = mapOf('forestMap').r.mul(winter).mul(0.7);
  const gray = vec3(dot(photo, vec3(0.299, 0.587, 0.114)));
  // Relief du domaine : normale lue par pixel (altitudes à ~7 m), bien plus fine que le maillage,
  // comme l'ombrage de la carte MapLibre ; ailleurs, celle du maillage.
  const slope = withSlopes ? mapOf('slopeMap').rg : null;
  const normal = slope ? vec3(slope.x.negate(), 1, slope.y.negate()).normalize() : normalWorld;
  // Altitude réelle (m) : le relief affiché est exagéré.
  const elev = positionWorld.y.div(EXAGGERATION);
  // Couche de neige : mêmes paliers que la carte MapLibre (opacité 0,25 à 400 m, 0,6 à 800 m,
  // 0,8 à 1 200 m, 0,92 à 1 700 m, pleine à 2 100 m), interpolés en ligne droite entre eux.
  const ramp = (from: number, to: number) => clamp(elev.sub(from).div(to - from), 0, 1);
  const snow = float(0.25)
    .add(ramp(400, 800).mul(0.35))
    .add(ramp(800, 1200).mul(0.2))
    .add(ramp(1200, 1700).mul(0.12))
    .add(ramp(1700, 2100).mul(0.08))
    .mul(winter);
  // Pente au-delà de ~30-40° (réels ; la normale vient du relief exagéré) en altitude : roche.
  const steep = float(1).sub(smoothstep(0.705, 0.822, normal.y));
  const rock = steep.mul(smoothstep(1750, 2050, elev)).mul(winter);
  const base = mix(mix(photo, gray.mul(0.9), winter), SNOW, snow);
  // Forêt : vert sombre texturé par la photo (cimes, trouées), poudré de neige.
  const woods = mix(FOREST, photo.mul(0.75), 0.45).add(gray.mul(0.12));
  const ground = mix(mix(base, gray.mul(vec3(1.04, 1.0, 0.95)), rock), woods, forest);
  let colorNode: ColorNode = ground;
  if (withParks) {
    // Parcs par-dessus le reste, comme les calques de la carte MapLibre (sous les pistes).
    // Mélange en sRGB (comme un calque MapLibre) : en linéaire, l'orange sur la neige vire au saumon.
    const cover = mapOf('parkMap');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nœuds vec3 et color mêlés
    const toSrgb = (c: any) => pow(c, vec3(1 / 2.2));
    const painted = mix(mix(toSrgb(ground), toSrgb(PARK_ORANGE), cover.r.mul(parksShown)), toSrgb(PARK_YELLOW), cover.g.mul(parksShown));
    colorNode = pow(painted, vec3(2.2));
  }
  const graph = { color: colorNode, normal: slope ? transformNormalToView(normal) : null };
  graphs.set(key, graph);
  return graph;
}

/** Matériau d'une tuile : photo provisoire grise, remplacée à son arrivée (`photoMap`). */
function chunkMaterial(forestMask: THREE.Texture, normalMap: THREE.Texture | null, overlay: THREE.Texture | null) {
  const nodes = terrainNodes(!!normalMap, !!overlay);
  // Deux faces : la jupe est vue d'un côté ou de l'autre selon le bord.
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  const maps: ChunkMaps = { photoMap: PLACEHOLDER, forestMap: forestMask };
  if (normalMap) maps.slopeMap = normalMap;
  if (overlay) maps.parkMap = overlay;
  Object.assign(material, maps);
  material.colorNode = nodes.color;
  if (nodes.normal) material.normalNode = nodes.normal;
  return material as THREE.MeshStandardNodeMaterial & ChunkMaps;
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

/**
 * Pentes par pixel d'une tuile du domaine, tirées directement des altitudes (tuiles 14 : 2^(14−z)
 * par côté), relief exagéré compris : texture RG en demi-flottants, dh/dx (est) et dh/dz (sud).
 * Les pentes plutôt que des normales sur 8 bits : sur les pentes douces, 8 bits donnaient des
 * paliers d'éclairage visibles (stries). Calculées par le worker du relief (terrain.worker.ts),
 * altitudes adoucies d'abord (flou d'environ 10 m : sinon, des carrés sur la neige vue de près).
 */
function normalTexture(data: Uint16Array, maxAnisotropy: number): THREE.Texture {
  const N = Math.sqrt(data.length / 2);
  const tex = new THREE.DataTexture(data, N, N, THREE.RGFormat, THREE.HalfFloatType);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAnisotropy;
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

  // Altitudes de la grille et d'un rang de plus tout autour (hors de la tuile), lues une seule fois :
  // les normales en sont tirées par différences centrées, continues d'une tuile à l'autre.
  const zstep = (z1 - z0) / S;
  const G = S + 3;
  const heights = new Float32Array(G * G);
  for (let j = -1; j <= S + 1; j++) {
    for (let i = -1; i <= S + 1; i++) heights[(j + 1) * G + i + 1] = height(x0 + i * step, z0 + j * zstep);
  }
  const at = (i: number, j: number) => heights[(j + 1) * G + i + 1];
  for (let j = 0; j <= S; j++) {
    for (let i = 0; i <= S; i++) {
      const k = j * side + i;
      positions[k * 3] = x0 + i * step;
      positions[k * 3 + 1] = at(i, j);
      positions[k * 3 + 2] = z0 + j * zstep;
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * step);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * zstep);
      const l = Math.hypot(dx, 1, dz);
      normals[k * 3] = -dx / l;
      normals[k * 3 + 1] = 1 / l;
      normals[k * 3 + 2] = -dz / l;
      uvs[k * 2] = i / S;
      uvs[k * 2 + 1] = j / S;
    }
  }

  const indices: number[] = [];
  const ex = spec.exclude;
  const covered = (x: number, z: number) => !!ex && x >= ex[0] && x <= ex[2] && z >= ex[1] && z <= ex[3];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      // Maille entièrement sous un niveau plus fin : rien à dessiner (ses bords restent, pas de trou).
      if (covered(positions[a * 3], positions[a * 3 + 2]) && covered(positions[d * 3], positions[d * 3 + 2])) continue;
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

/**
 * Tuile du relief. `slopes` : pentes par pixel (tuiles du domaine seulement, voir normalTexture) ;
 * sans elles (horizon, ou worker indisponible), les normales du maillage.
 */
export function buildChunk(
  frame: Frame,
  elev: Elevation,
  spec: ChunkSpec,
  maxAnisotropy: number,
  forests: number[][][][],
  overlay?: OverlayPainter,
  slopes?: Uint16Array | null,
): Chunk {
  const geometry = chunkGeometry(frame, elev, spec);
  const normals = slopes ? normalTexture(slopes, maxAnisotropy) : null;
  const [rx0, , rx1] = frame.tileRect(spec.z, spec.x, spec.y);
  const cover = overlay ? overlay(spec.z, spec.x, spec.y, (rx1 - rx0) / PARK_OVERLAY_SIZE) : null;
  if (cover) cover.anisotropy = maxAnisotropy;
  const material = chunkMaterial(forestMask(spec, forests), normals, cover);
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
      const old = material.photoMap;
      material.photoMap = tex;
      if (old !== PLACEHOLDER) old.dispose();
    },
  };
}
