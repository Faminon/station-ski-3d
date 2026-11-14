// Sapins 3D dessinés directement en WebGL (calque personnalisé de MapLibre),
// en remplacement des volumes « fill-extrusion ».
//
// Pourquoi : en grand format, les dizaines de milliers de volumes des sapins
// coûtaient l'essentiel du temps de la carte graphique. Ici, un seul modèle de
// sapin (trois cônes à six pans, 18 triangles, contre 64 à 80 auparavant) est
// répété en une commande par tuile (« instanciation ») : par arbre, la carte
// graphique ne reçoit que sa position, sa taille et sa teinte.
//
// - Les arbres viennent du worker (forestPlanting.ts, mêmes emplacements et
//   mêmes couloirs dégagés qu'avant), par tuiles : de près des tuiles 15–16
//   (arbres serrés), au loin des tuiles 13–14 (arbres plus grands et espacés).
//   Le choix des tuiles suit la distance à la caméra, comme pour MapLibre.
// - Altitude : MapLibre dessine, à notre demande, l'altitude du relief tel
//   qu'il est affiché dans deux textures (de près et au loin). Chaque sapin y
//   lit l'altitude sous son pied : il est posé exactement sur le terrain visible.
// - Densité : les arbres de chaque tuile sont triés par rang, la qualité
//   adaptative n'en dessine que les premiers.

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import { GREENS, SNOW_CAP, TREE_INSTANCE_FLOATS, TREES_MAX_TILE_ZOOM, TREES_MIN_TILE_ZOOM } from './forestPlanting';

export interface TreeTileData {
  /** Par arbre : décalage mercator (x, y) depuis le coin nord-ouest de la tuile, hauteur, largeur (m), teinte. */
  data: Float32Array;
  /** Rang de chaque arbre, croissant. */
  ranks: Float32Array;
}
export type RequestTreeTile = (z: number, x: number, y: number, signal: AbortSignal) => Promise<TreeTileData>;

export interface InstancedForestLayer extends CustomLayerInterface {
  /** Part des sapins dessinés (0 à 1). */
  setDensity(density: number): void;
  /** Les arbres ont changé (couloirs dégagés) : toutes les tuiles sont redemandées. */
  reset(): void;
}

/** Le navigateur sait-il dessiner ce calque ? (WebGL 2 et textures de nombres décimaux en sortie.) */
export function supportsInstancedForest(map: MlMap): boolean {
  try {
    const gl = map.getCanvas().getContext('webgl2');
    return !!gl && !!gl.getExtension('EXT_color_buffer_float');
  } catch {
    return false;
  }
}

/** En dessous, le motif de sapins au sol suffit ; les sapins apparaissent sur 0,6 niveau de zoom. */
const MIN_ZOOM = 13.5;
const FADE_ZOOMS = 0.6;
/** Tuiles affichées au plus (les plus proches d'abord) et tuiles gardées en mémoire. */
const MAX_TILES = 60;
const CACHE_TILES = 160;
/**
 * Part des arbres dessinés au loin, par niveau de tuile : à plusieurs kilomètres, un sapin fait
 * quelques pixels et le brouillard l'estompe, la forêt se lit aussi bien avec moins d'arbres.
 */
const DISTANT_DENSITY: Record<number, number> = { 13: 0.45, 14: 0.7 };
/** Fréquence du choix des tuiles pendant un déplacement (ms). */
const SELECT_EVERY_MS = 200;
/** Textures d'altitude : de près (tuiles 15 et 16), au loin (tuiles 13 et 14). */
const NEAR_HEIGHT_SIZE = 1024;
const FAR_HEIGHT_SIZE = 512;
/** Brouillard au loin, comme sur le relief (m). */
const FOG_START_M = 3500;
const FOG_END_M = 16000;
const FOG_MAX = 0.6;
const FOG_COLOR = '#e4f1fb';
/** Lumière venant du nord-ouest et d'en haut, comme l'ombrage du relief (est, nord, haut). */
const LIGHT = normalize([-0.55, 0.55, 0.63]);

// ---- Modèle de sapin --------------------------------------------------------------------

/** Étages : rayon (× largeur de l'arbre), bas, sommet (× hauteur), neige au sommet (0 à 1), rotation. */
const TIERS: [number, number, number, number, number][] = [
  [3.4, 0.04, 0.6, 0.3, 0],
  [2.5, 0.34, 0.83, 0.4, Math.PI / 6],
  [1.55, 0.58, 1.0, 0.95, 0],
];
const SEGMENTS = 6;
/** Valeurs par sommet : position (3), normale (3), neige (1). */
const VERTEX_FLOATS = 7;

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Sommets du sapin unité (x, y en largeurs d'arbre, z en hauteur d'arbre) : faces planes, ombrage net. */
function treeMesh(): Float32Array {
  const out: number[] = [];
  for (const [r, base, apex, snow, rot] of TIERS) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a0 = rot + (s / SEGMENTS) * Math.PI * 2;
      const a1 = rot + ((s + 1) / SEGMENTS) * Math.PI * 2;
      const p0 = [Math.cos(a0) * r, Math.sin(a0) * r, base];
      const p1 = [Math.cos(a1) * r, Math.sin(a1) * r, base];
      const top = [0, 0, apex];
      // Normale de la face, tournée vers l'extérieur (et donc vers le haut). Elle se calcule à
      // l'échelle d'un arbre type (2,5 fois plus haut que large), pour une pente réaliste.
      const u = [p0[0] - top[0], p0[1] - top[1], (p0[2] - top[2]) * 2.5];
      const v = [p1[0] - top[0], p1[1] - top[1], (p1[2] - top[2]) * 2.5];
      let n = normalize([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
      for (const [p, w] of [
        [top, snow],
        [p0, 0],
        [p1, 0],
      ] as const)
        out.push(p[0], p[1], p[2], n[0], n[1], n[2], w);
    }
  }
  return new Float32Array(out);
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_snow;
layout(location = 3) in vec4 a_tree;
layout(location = 4) in float a_green;
uniform mat4 u_matrix;
uniform float u_meter;
uniform sampler2D u_height;
uniform vec4 u_hm;
uniform vec2 u_hm_size;
uniform vec3 u_camera;
uniform vec3 u_greens[3];
uniform vec3 u_snow;
uniform vec3 u_light;
uniform vec3 u_fog_color;
uniform vec3 u_fog;
uniform float u_opacity;
out vec4 v_color;

float heightAt(vec2 uv) {
  vec2 p = uv * u_hm_size - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  ivec2 hi = ivec2(u_hm_size) - 1;
  float a = texelFetch(u_height, clamp(i, ivec2(0), hi), 0).r;
  float b = texelFetch(u_height, clamp(i + ivec2(1, 0), ivec2(0), hi), 0).r;
  float c = texelFetch(u_height, clamp(i + ivec2(0, 1), ivec2(0), hi), 0).r;
  float d = texelFetch(u_height, clamp(i + ivec2(1, 1), ivec2(0), hi), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float ground = heightAt(u_hm.xy + a_tree.xy * u_hm.zw);
  float h = a_tree.z;
  float w = a_tree.w;
  // Le modèle a le nord vers le haut, le mercator vers le bas ; le pied est un peu enfoncé
  // pour qu'un écart de quelques décimètres avec le relief ne laisse pas l'arbre flotter.
  vec3 local = vec3(a_pos.x * w, -a_pos.y * w, a_pos.z * h - 0.06 * h) * u_meter;
  vec3 pos = vec3(a_tree.xy, ground * u_meter) + local;
  gl_Position = u_matrix * vec4(pos, 1.0);

  float light = 0.45 + 0.55 * max(dot(a_normal, u_light), 0.0);
  vec3 green = u_greens[int(a_green + 0.5)];
  vec3 color = mix(green * light, u_snow * (0.72 + 0.28 * light), a_snow);
  float fog = smoothstep(u_fog.x, u_fog.y, distance(pos, u_camera)) * u_fog.z;
  color = mix(color, u_fog_color, fog);
  v_color = vec4(color * u_opacity, u_opacity);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 fragColor;
void main() {
  fragColor = v_color;
}`;

// ---- Tuiles -----------------------------------------------------------------------------

interface TileEntry {
  z: number;
  x: number;
  y: number;
  key: string;
  state: 'loading' | 'ready' | 'failed';
  abort?: AbortController;
  data?: TreeTileData;
  buffer?: WebGLBuffer | null;
  vao?: WebGLVertexArrayObject | null;
  lastUsed: number;
}

const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;
const isAncestor = (a: TileEntry, b: { z: number; x: number; y: number }) => a.z < b.z && b.x >> (b.z - a.z) === a.x && b.y >> (b.z - a.z) === a.y;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Mètres → unités mercator, à la latitude d'une ordonnée mercator. */
function meterAt(mercatorY: number): number {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180) / Math.PI;
  return 1 / (40_075_016.686 * Math.cos((lat * Math.PI) / 180));
}

const mercatorX = (lng: number) => (lng + 180) / 360;
const mercatorY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

interface CameraTransform {
  getCameraLngLat(): { lng: number; lat: number };
  getCameraAltitude(): number;
}

/** Position de la caméra en coordonnées mercator (altitude au-dessus de la mer, en unités mercator). */
function cameraMercator(map: MlMap): { x: number; y: number; z: number } {
  // Position exacte, lue dans la caméra de MapLibre (accès interne) quand elle est disponible.
  const t = (map as unknown as { _camera?: { transform?: Partial<CameraTransform> } })._camera?.transform;
  if (typeof t?.getCameraLngLat === 'function' && typeof t.getCameraAltitude === 'function') {
    const lngLat = t.getCameraLngLat();
    const y = mercatorY(lngLat.lat);
    return { x: mercatorX(lngLat.lng), y, z: t.getCameraAltitude() * meterAt(y) };
  }
  // Sinon, recalculée comme MapLibre la place : en retrait du centre selon l'inclinaison et l'orientation,
  // à une distance qui dépend du zoom et du champ de vision (36,87° par défaut).
  const center = map.getCenter();
  const cx = mercatorX(center.lng);
  const cy = mercatorY(center.lat);
  const height = map.getCanvas().clientHeight || 600;
  const distance = (0.5 / Math.tan((36.87 * Math.PI) / 360)) * height / (512 * 2 ** map.getZoom());
  const pitch = (map.getPitch() * Math.PI) / 180;
  const bearing = (map.getBearing() * Math.PI) / 180;
  const ground = (map.queryTerrainElevation(center) ?? 0) * meterAt(cy);
  return {
    x: cx - Math.sin(bearing) * Math.sin(pitch) * distance,
    y: cy + Math.cos(bearing) * Math.sin(pitch) * distance,
    z: ground + Math.cos(pitch) * distance,
  };
}

export function createInstancedForestLayer(options: {
  id: string;
  map: MlMap;
  request: RequestTreeTile;
  /** Emprise des forêts [ouest, sud, est, nord] : aucune tuile demandée au-delà. */
  bounds: [number, number, number, number];
}): InstancedForestLayer {
  const { map, request } = options;
  const forestBox = [mercatorX(options.bounds[0]), mercatorY(options.bounds[3]), mercatorX(options.bounds[2]), mercatorY(options.bounds[1])];
  const tiles = new Map<string, TileEntry>();
  let displayed: TileEntry[] = [];
  let density = 1;
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let meshBuffer: WebGLBuffer | null = null;
  let vertexCount = 0;
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  const heightMaps = {
    near: { texture: null as WebGLTexture | null, size: NEAR_HEIGHT_SIZE, bounds: [0, 0, 0, 0] as [number, number, number, number] },
    far: { texture: null as WebGLTexture | null, size: FAR_HEIGHT_SIZE, bounds: [0, 0, 0, 0] as [number, number, number, number] },
  };
  let lastSelect = 0;
  let selectionDirty = true;
  let heightsDirty = true;

  const repaint = () => map.triggerRepaint();
  // Nouvelles altitudes du relief (tuiles plus fines arrivées) : textures à redessiner.
  const onSourceData = (e: { sourceId?: string; tile?: unknown }) => {
    if (e.sourceId === 'dem' && e.tile) heightsDirty = true;
  };
  const onMoveEnd = () => {
    selectionDirty = true;
    // Caméra arrêtée : altitudes redessinées d'après le relief tel qu'il est maintenant affiché.
    heightsDirty = true;
    repaint();
  };

  // ---- Choix des tuiles ----

  function select() {
    const zoom = map.getZoom();
    if (zoom < MIN_ZOOM) {
      displayed = [];
      return;
    }
    const camera = cameraMercator(map);
    const center = map.getCenter();
    const cx = mercatorX(center.lng);
    const cy = mercatorY(center.lat);
    const s = meterAt(cy);
    const groundM = map.queryTerrainElevation(center) ?? 0;
    // Hauteur de la caméra au-dessus du sol (au moins 50 m), en unités mercator.
    const camH = Math.max(50 * s, camera.z - groundM * s);
    const dCenter = Math.hypot(camera.x - cx, camera.y - cy, camH);
    const view = map.getBounds();
    const vb = [mercatorX(view.getWest()), mercatorY(view.getNorth()), mercatorX(view.getEast()), mercatorY(view.getSouth())];
    const box = [Math.max(vb[0], forestBox[0]), Math.max(vb[1], forestBox[1]), Math.min(vb[2], forestBox[2]), Math.min(vb[3], forestBox[3])];
    if (box[0] >= box[2] || box[1] >= box[3]) {
      displayed = [];
      return;
    }

    // Tuile voulue à une distance donnée : comme MapLibre, un niveau de moins à chaque doublement.
    const wanted: { z: number; x: number; y: number; d: number }[] = [];
    const visit = (z: number, x: number, y: number) => {
      const n = 2 ** z;
      const [x0, y0, x1, y1] = [x / n, y / n, (x + 1) / n, (y + 1) / n];
      if (x1 <= box[0] || x0 >= box[2] || y1 <= box[1] || y0 >= box[3]) return;
      const dx = Math.max(x0 - camera.x, 0, camera.x - x1);
      const dy = Math.max(y0 - camera.y, 0, camera.y - y1);
      const d = Math.hypot(dx, dy, camH);
      // Jamais plus détaillé qu'au centre de la vue (plus près, les arbres restent ceux du centre),
      // et un niveau de moins à chaque doublement de la distance au-delà.
      const ideal = Math.floor(zoom + Math.min(0, Math.log2(dCenter / d)));
      if (ideal < TREES_MIN_TILE_ZOOM) return;
      if (ideal > z && z < TREES_MAX_TILE_ZOOM) {
        for (let i = 0; i < 4; i++) visit(z + 1, 2 * x + (i & 1), 2 * y + (i >> 1));
        return;
      }
      wanted.push({ z, x, y, d });
    };
    const n13 = 2 ** TREES_MIN_TILE_ZOOM;
    for (let x = Math.floor(box[0] * n13); x <= Math.floor(box[2] * n13); x++) {
      for (let y = Math.floor(box[1] * n13); y <= Math.floor(box[3] * n13); y++) visit(TREES_MIN_TILE_ZOOM, x, y);
    }
    wanted.sort((a, b) => a.d - b.d);
    wanted.length = Math.min(wanted.length, MAX_TILES);

    const now = performance.now();
    const entries = wanted.map(({ z, x, y }) => {
      const key = tileKey(z, x, y);
      let entry = tiles.get(key);
      if (!entry) {
        entry = { z, x, y, key, state: 'loading', abort: new AbortController(), lastUsed: now };
        tiles.set(key, entry);
        const e = entry;
        request(z, x, y, e.abort!.signal).then(
          (data) => {
            if (tiles.get(key) !== e) return;
            e.data = data;
            e.state = 'ready';
            selectionDirty = true;
            repaint();
          },
          () => {
            if (tiles.get(key) === e) e.state = 'failed';
          },
        );
      }
      entry.lastUsed = now;
      return entry;
    });

    // Tuile pas encore prête : on garde ce qui couvrait sa place, pour ne pas laisser de trou.
    const previous = displayed;
    const kept = new Set<TileEntry>();
    for (const w of entries) {
      if (w.state === 'ready') continue;
      const ancestor = previous.find((p) => isAncestor(p, w));
      if (ancestor) kept.add(ancestor);
      else for (const p of previous) if (isAncestor(w, p)) kept.add(p);
    }
    const next = entries.filter((w) => w.state === 'ready' && ![...kept].some((k) => isAncestor(k, w)));
    for (const k of kept) k.lastUsed = now;
    displayed = [...next, ...kept];
    // Demandes devenues inutiles : abandonnées ; mémoire limitée : les tuiles les plus anciennes partent.
    for (const entry of tiles.values()) {
      if (entry.state === 'loading' && entry.lastUsed < now) {
        entry.abort?.abort();
        tiles.delete(entry.key);
      }
    }
    if (tiles.size > CACHE_TILES) {
      const old = [...tiles.values()].filter((e) => !displayed.includes(e) && e.lastUsed < now).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const e of old.slice(0, tiles.size - CACHE_TILES)) release(e);
    }
  }

  function release(entry: TileEntry) {
    entry.abort?.abort();
    if (gl) {
      if (entry.vao) gl.deleteVertexArray(entry.vao);
      if (entry.buffer) gl.deleteBuffer(entry.buffer);
    }
    tiles.delete(entry.key);
  }

  // ---- WebGL ----

  function compile(type: number, source: string): WebGLShader {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(`Sapins : ${gl!.getShaderInfoLog(shader)}`);
    return shader;
  }

  function heightTexture(size: number): WebGLTexture {
    const texture = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R32F, size, size, 0, gl!.RED, gl!.FLOAT, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    return texture;
  }

  /** Tampon et description des arbres d'une tuile, créés au premier dessin. */
  function tileVao(entry: TileEntry): WebGLVertexArrayObject | null {
    if (entry.vao || !entry.data || !gl) return entry.vao ?? null;
    entry.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, entry.data.data, gl.STATIC_DRAW);
    entry.vao = gl.createVertexArray();
    gl.bindVertexArray(entry.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
    const stride = VERTEX_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    const instanceStride = TREE_INSTANCE_FLOATS * 4;
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, instanceStride, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, instanceStride, 16);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return entry.vao;
  }

  /** Nombre d'arbres de la tuile à dessiner pour la densité courante (arbres triés par rang). */
  function countFor(entry: TileEntry): number {
    const ranks = entry.data?.ranks;
    if (!ranks) return 0;
    const wanted = density * (DISTANT_DENSITY[entry.z] ?? 1);
    if (wanted >= 1) return ranks.length;
    let lo = 0;
    let hi = ranks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranks[mid] < wanted) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const boundsOf = (list: TileEntry[]): [number, number, number, number] | null => {
    if (!list.length) return null;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of list) {
      const n = 2 ** t.z;
      x0 = Math.min(x0, t.x / n);
      y0 = Math.min(y0, t.y / n);
      x1 = Math.max(x1, (t.x + 1) / n);
      y1 = Math.max(y1, (t.y + 1) / n);
    }
    return [x0, y0, x1, y1];
  };
  const isNear = (t: TileEntry) => t.z >= 15;

  const layer: InstancedForestLayer = {
    id: options.id,
    type: 'custom',
    renderingMode: '3d',

    onAdd(_map, context) {
      gl = context as WebGL2RenderingContext;
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Sapins : ${gl.getProgramInfoLog(program)}`);
      for (const name of ['u_matrix', 'u_meter', 'u_height', 'u_hm', 'u_hm_size', 'u_camera', 'u_greens', 'u_snow', 'u_light', 'u_fog_color', 'u_fog', 'u_opacity']) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      const mesh = treeMesh();
      vertexCount = mesh.length / VERTEX_FLOATS;
      meshBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      heightMaps.near.texture = heightTexture(NEAR_HEIGHT_SIZE);
      heightMaps.far.texture = heightTexture(FAR_HEIGHT_SIZE);
      map.on('sourcedata', onSourceData);
      map.on('moveend', onMoveEnd);
    },

    onRemove() {
      map.off('sourcedata', onSourceData);
      map.off('moveend', onMoveEnd);
      for (const entry of [...tiles.values()]) release(entry);
      if (gl) {
        if (program) gl.deleteProgram(program);
        if (meshBuffer) gl.deleteBuffer(meshBuffer);
        for (const hm of Object.values(heightMaps)) if (hm.texture) gl.deleteTexture(hm.texture);
      }
      gl = null;
    },

    // Passe hors écran : choix des tuiles, puis altitudes du relief affiché sous les arbres.
    prerender(_gl, args: CustomRenderMethodInput) {
      if (!gl) return;
      const now = performance.now();
      const moving = map.isMoving();
      if (selectionDirty || (moving && now - lastSelect > SELECT_EVERY_MS)) {
        selectionDirty = false;
        lastSelect = now;
        select();
      }
      if (!args.renderTerrainHeightMap || !displayed.length) return;
      // Altitudes redessinées seulement quand la zone couverte change, quand des altitudes plus fines
      // arrivent ou quand la caméra s'arrête : pas à chaque image, ce qui coûterait à la carte graphique.
      const all = heightsDirty;
      heightsDirty = false;
      for (const [name, list] of [
        ['near', displayed.filter(isNear)],
        ['far', displayed.filter((t) => !isNear(t))],
      ] as const) {
        const bounds = boundsOf(list);
        const hm = heightMaps[name];
        if (!bounds || !hm.texture) continue;
        if (!all && bounds.every((v, i) => v === hm.bounds[i])) continue;
        hm.bounds = bounds;
        args.renderTerrainHeightMap({ texture: hm.texture, width: hm.size, height: hm.size, bounds });
      }
    },

    render(_gl, args: CustomRenderMethodInput) {
      if (!gl || !program || !displayed.length) return;
      const zoom = map.getZoom();
      const opacity = Math.max(0, Math.min(1, (zoom - MIN_ZOOM) / FADE_ZOOMS));
      if (opacity <= 0) return;
      const camera = cameraMercator(map);

      gl.useProgram(program);
      const greens = GREENS.flatMap(hexToRgb);
      gl.uniform3fv(uniforms.u_greens, greens);
      gl.uniform3fv(uniforms.u_snow, hexToRgb(SNOW_CAP));
      gl.uniform3fv(uniforms.u_light, LIGHT);
      gl.uniform3fv(uniforms.u_fog_color, hexToRgb(FOG_COLOR));
      gl.uniform1f(uniforms.u_opacity, opacity);
      gl.uniform1i(uniforms.u_height, 0);
      gl.activeTexture(gl.TEXTURE0);

      // Matrice prévue pour des coordonnées mercator de 0 à 1 (z en unités mercator, relief 3D).
      const m = args.defaultProjectionData.mainMatrix;
      const matrix = new Float32Array(16);
      let bound: WebGLTexture | null = null;
      for (const entry of displayed) {
        const count = countFor(entry);
        if (!count) continue;
        const vao = tileVao(entry);
        if (!vao) continue;
        const hm = isNear(entry) ? heightMaps.near : heightMaps.far;
        if (hm.texture !== bound) {
          gl.bindTexture(gl.TEXTURE_2D, hm.texture);
          bound = hm.texture;
          gl.uniform2f(uniforms.u_hm_size, hm.size, hm.size);
        }
        const n = 2 ** entry.z;
        const ox = entry.x / n;
        const oy = entry.y / n;
        // Matrice recentrée sur le coin de la tuile, calculée en double précision : les positions
        // des arbres restent petites, sans tremblement à fort zoom.
        for (let i = 0; i < 4; i++) {
          matrix[i] = m[i];
          matrix[4 + i] = m[4 + i];
          matrix[8 + i] = m[8 + i];
          matrix[12 + i] = m[i] * ox + m[4 + i] * oy + m[12 + i];
        }
        gl.uniformMatrix4fv(uniforms.u_matrix, false, matrix);
        const meter = meterAt(oy + 0.5 / n);
        gl.uniform1f(uniforms.u_meter, meter);
        const [bx0, by0, bx1, by1] = hm.bounds;
        const bw = bx1 - bx0 || 1;
        const bh = by1 - by0 || 1;
        // Première ligne de la texture au sud : v = (sud − y) / hauteur.
        gl.uniform4f(uniforms.u_hm, (ox - bx0) / bw, (by1 - oy) / bh, 1 / bw, -1 / bh);
        gl.uniform3f(uniforms.u_camera, camera.x - ox, camera.y - oy, camera.z);
        gl.uniform3f(uniforms.u_fog, FOG_START_M * meter, FOG_END_M * meter, FOG_MAX);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, count);
      }
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },

    setDensity(d) {
      density = Math.max(0, Math.min(1, d));
      repaint();
    },
    reset() {
      for (const entry of [...tiles.values()]) release(entry);
      displayed = [];
      selectionDirty = true;
      repaint();
    },
  };
  return layer;
}
