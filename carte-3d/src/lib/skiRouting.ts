// Itinéraires à ski sur un domaine : on ne circule que par les pistes (en
// descendant), les remontées (en montant, ou en descendant pour les
// télécabines et téléphériques, comme les piétons) et de courts passages à
// pied d'un tracé à l'autre. Le chemin retenu est le plus rapide (Dijkstra sur
// des temps estimés), pas le plus court.
//
// Le sens des pistes vient de l'altitude (voir terrainSampler) : OpenStreetMap
// ne garantit pas le sens de tracé d'une piste, contrairement aux remontées,
// tracées du bas vers le haut.

export type SkiLevel = 'all' | 'noBlack' | 'easy';

export interface RouteLine {
  name: string;
  /** Difficulté (pistes) ou type de remontée. */
  detail: string;
  coordinates: number[][];
}

export type StepKind = 'piste' | 'lift' | 'walk';

export interface RouteStep {
  kind: StepKind;
  name: string;
  /** Difficulté de la piste ou type de remontée. */
  detail: string;
  /** Mètres parcourus. */
  distance: number;
  /** Secondes estimées. */
  time: number;
  coordinates: number[][];
  /** Remontée prise à la descente (télécabines, téléphériques). */
  descending?: boolean;
}

export interface RouteTarget {
  id: string;
  name: string;
  lng: number;
  lat: number;
}

export interface RouteResult {
  target: RouteTarget;
  time: number;
  distance: number;
  steps: RouteStep[];
}

// ---------------------------------------------------------------------------
// Hypothèses de vitesse (m/s) et d'attente (s), pour un skieur moyen.

const SKI_SPEED: Record<string, number> = { green: 5, blue: 7, red: 8, black: 7, unknown: 6 };
/** Passage presque plat ou en légère montée sur une piste : on pousse sur les bâtons. */
const SKATE_SPEED = 1.5;
const WALK_SPEED = 1.1;
const WALK_DOWN_SPEED = 2;

const LIFT_SPEED: Record<string, number> = {
  chair_lift: 4.5, gondola: 5.5, cable_car: 9, mixed_lift: 5, funicular: 8,
  platter: 3, drag_lift: 3, 't-bar': 3, 'j-bar': 3, rope_tow: 2, magic_carpet: 1,
};
const LIFT_WAIT: Record<string, number> = {
  chair_lift: 120, gondola: 90, cable_car: 240, mixed_lift: 120, funicular: 180,
  platter: 60, drag_lift: 60, 't-bar': 60, 'j-bar': 60, rope_tow: 30, magic_carpet: 30,
};
/** Remontées que l'on peut aussi prendre à la descente. */
const DESCENDABLE = new Set(['gondola', 'cable_car', 'funicular']);
/** Pénalité d'une descente en remontée : un skieur préfère la piste, sauf si elle manque ou ne lui convient pas. */
const DESCENT_PENALTY_S = 600;

/** Écart d'altitude en deçà duquel un tronçon de piste est jugé plat (bruit du relief compris). */
const FLAT_M = 4;
/**
 * Dénivelé entre les deux bouts d'une piste au-delà duquel elle est à sens
 * unique. Le sens se juge sur la piste entière : tronçon par tronçon, le
 * relief (un pixel ≈ 25 m) ferait paraître « en montée » des bouts de descente.
 */
const ONE_WAY_DROP_M = 15;
/** Longueur maximale d'un tronçon : au-delà, on ajoute des points pour capter les croisements. */
const MAX_SEGMENT_M = 40;
/** Rayon des passages à pied entre deux tracés, et autour des gares de remontée (souvent un peu à l'écart). */
const TRANSFER_M = 35;
const STATION_TRANSFER_M = 90;
/** Montée maximale acceptée à pied pour rejoindre un tracé voisin. */
const MAX_WALK_RISE_M = 15;
/** Rayon de rattachement du départ et des destinations au réseau. */
const ATTACH_M = 250;
/** Au-delà, le point est jugé hors du domaine : pas d'itinéraire. */
const MAX_ATTACH_M = 2000;

const METERS_PER_DEG_LAT = 110_574;

interface Edge {
  to: number;
  time: number;
  dist: number;
  kind: StepKind;
  /** Index du tracé (piste ou remontée), -1 pour un passage à pied. */
  line: number;
}

interface GraphNode {
  lng: number;
  lat: number;
  x: number;
  y: number;
  z: number;
  /** Tracé d'origine (pistes : index ; remontées : 10 000 + index). */
  owner: number;
}

export interface SkiGraph {
  nodes: GraphNode[];
  adj: Edge[][];
  pistes: RouteLine[];
  lifts: RouteLine[];
  /** Nœud de la gare de départ de chaque remontée. */
  liftBottoms: { node: number; lift: number }[];
  mx: number;
  cell: Map<string, number[]>;
}

const CELL_M = 50;
const cellKey = (x: number, y: number) => `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;

/**
 * Construit le réseau du domaine. `elevation` donne l'altitude réelle d'un
 * point (null si inconnue : le tronçon est alors parcourable dans les deux sens).
 */
export function buildSkiGraph(pistes: RouteLine[], lifts: RouteLine[], elevation: (lng: number, lat: number) => number | null): SkiGraph {
  // Copie : les remontées tracées à l'envers sont remises dans le bon sens sans toucher aux données d'origine.
  lifts = lifts.map((l) => ({ ...l }));
  const lat0 = pistes[0]?.coordinates[0]?.[1] ?? 45;
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const nodes: GraphNode[] = [];
  const adj: Edge[][] = [];
  const cell = new Map<string, number[]>();

  const addNode = (lng: number, lat: number, owner: number): number => {
    const x = lng * mx;
    const y = lat * METERS_PER_DEG_LAT;
    const id = nodes.length;
    nodes.push({ lng, lat, x, y, z: elevation(lng, lat) ?? NaN, owner });
    adj.push([]);
    const k = cellKey(x, y);
    const list = cell.get(k);
    if (list) list.push(id);
    else cell.set(k, [id]);
    return id;
  };
  const dist = (a: number, b: number) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);

  // Pistes : orientées d'un bout à l'autre par l'altitude.
  pistes.forEach((p, li) => {
    const first = p.coordinates[0];
    const last = p.coordinates[p.coordinates.length - 1];
    const z0 = elevation(first[0], first[1]);
    const z1 = elevation(last[0], last[1]);
    // +1 : tracée dans le sens de la descente ; −1 : à l'envers ; 0 : à plat ou inconnu, dans les deux sens.
    const way = z0 === null || z1 === null || Math.abs(z1 - z0) <= ONE_WAY_DROP_M ? 0 : z1 < z0 ? 1 : -1;
    let prev = -1;
    for (let i = 0; i < p.coordinates.length; i++) {
      const [lng, lat] = p.coordinates[i];
      if (prev >= 0) {
        // Points intermédiaires sur les longs tronçons, pour capter les pistes qui s'y raccordent.
        const [plng, plat] = [nodes[prev].lng, nodes[prev].lat];
        const len = Math.hypot((lng - plng) * mx, (lat - plat) * METERS_PER_DEG_LAT);
        const parts = Math.ceil(len / MAX_SEGMENT_M);
        for (let k = 1; k <= parts; k++) {
          const t = k / parts;
          const id = addNode(plng + (lng - plng) * t, plat + (lat - plat) * t, li);
          linkPiste(prev, id, li, p.detail, way);
          prev = id;
        }
      } else {
        prev = addNode(lng, lat, li);
      }
    }
  });

  function linkPiste(a: number, b: number, line: number, difficulty: string, way: number) {
    const d = dist(a, b);
    const speed = SKI_SPEED[difficulty] ?? SKI_SPEED.unknown;
    if (way > 0) adj[a].push({ to: b, dist: d, line, kind: 'piste', time: d / speed });
    else if (way < 0) adj[b].push({ to: a, dist: d, line, kind: 'piste', time: d / speed });
    else {
      // Piste quasi plate (traversée, liaison) : dans les deux sens, en poussant sur les bâtons s'il le faut.
      const dz = nodes[b].z - nodes[a].z;
      const flat = !Number.isFinite(dz) || Math.abs(dz) <= FLAT_M;
      adj[a].push({ to: b, dist: d, line, kind: 'piste', time: d / (flat || dz < 0 ? speed : SKATE_SPEED) });
      adj[b].push({ to: a, dist: d, line, kind: 'piste', time: d / (flat || dz > 0 ? speed : SKATE_SPEED) });
    }
  }

  // Remontées : du bas vers le haut, d'une gare à l'autre.
  const liftBottoms: SkiGraph['liftBottoms'] = [];
  lifts.forEach((l, li) => {
    if (l.coordinates.length < 2) return;
    let coords = l.coordinates;
    let length = 0;
    for (let i = 1; i < coords.length; i++) {
      length += Math.hypot((coords[i][0] - coords[i - 1][0]) * mx, (coords[i][1] - coords[i - 1][1]) * METERS_PER_DEG_LAT);
    }
    const a = addNode(coords[0][0], coords[0][1], 10_000 + li);
    const b = addNode(coords[coords.length - 1][0], coords[coords.length - 1][1], 10_000 + li);
    // Tracé exceptionnellement dessiné du haut vers le bas : on le remet dans le bon sens.
    let [bottom, top] = [a, b];
    if (nodes[a].z > nodes[b].z + FLAT_M) {
      [bottom, top] = [b, a];
      coords = [...coords].reverse();
      lifts[li] = { ...l, coordinates: coords };
    }
    const time = length / (LIFT_SPEED[l.detail] ?? 4) + (LIFT_WAIT[l.detail] ?? 90);
    adj[bottom].push({ to: top, dist: length, time, kind: 'lift', line: li });
    if (DESCENDABLE.has(l.detail)) adj[top].push({ to: bottom, dist: length, time: time + DESCENT_PENALTY_S, kind: 'lift', line: -1 - li });
    liftBottoms.push({ node: bottom, lift: li });
  });

  // Passages à pied entre tracés voisins (croisements, gares de remontée).
  const isStation = (n: number) => nodes[n].owner >= 10_000;
  for (let i = 0; i < nodes.length; i++) {
    const ni = nodes[i];
    const cx = Math.floor(ni.x / CELL_M);
    const cy = Math.floor(ni.y / CELL_M);
    const reach = isStation(i) ? 2 : 1;
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const j of cell.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i || nodes[j].owner === ni.owner) continue;
          const d = dist(i, j);
          const radius = isStation(i) || isStation(j) ? STATION_TRANSFER_M : TRANSFER_M;
          if (d > radius) continue;
          const dz = nodes[j].z - ni.z;
          const known = Number.isFinite(dz);
          if (!known || dz <= MAX_WALK_RISE_M) adj[i].push({ to: j, dist: d, line: -1, kind: 'walk', time: d / (known && dz > 0 ? WALK_SPEED : WALK_DOWN_SPEED) + 5 });
          if (!known || dz >= -MAX_WALK_RISE_M) adj[j].push({ to: i, dist: d, line: -1, kind: 'walk', time: d / (known && dz < 0 ? WALK_SPEED : WALK_DOWN_SPEED) + 5 });
        }
      }
    }
  }

  return { nodes, adj, pistes, lifts, liftBottoms, mx, cell };
}

/** Nœuds du réseau à moins de `radius` mètres d'un point ; à défaut, les plus proches dans un rayon élargi (2 km au plus). */
function nodesNear(g: SkiGraph, lng: number, lat: number, radius: number): { node: number; d: number }[] {
  const x = lng * g.mx;
  const y = lat * METERS_PER_DEG_LAT;
  const reach = Math.ceil(radius / CELL_M);
  const cx = Math.floor(x / CELL_M);
  const cy = Math.floor(y / CELL_M);
  const found: { node: number; d: number }[] = [];
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (const n of g.cell.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = Math.hypot(g.nodes[n].x - x, g.nodes[n].y - y);
        if (d <= radius) found.push({ node: n, d });
      }
    }
  }
  if (!found.length && radius < MAX_ATTACH_M) {
    // Rien à proximité (départ choisi en pleine forêt, village à l'écart) : on cherche plus loin.
    return nodesNear(g, lng, lat, Math.min(radius * 2, MAX_ATTACH_M));
  }
  return found.sort((a, b) => a.d - b.d).slice(0, 12);
}

/** Tas binaire minimal pour Dijkstra. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.ids[0], this.keys[0]];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

/**
 * Pistes et remontées fermées (conditions en direct) : index dans `g.pistes` et `g.lifts`.
 * L'itinéraire les contourne ; les passages à pied restent possibles.
 */
export interface ClosedLines {
  pistes: Set<number>;
  lifts: Set<number>;
}

function allowed(g: SkiGraph, e: Edge, level: SkiLevel, closed?: ClosedLines): boolean {
  if (closed && e.line >= 0) {
    if (e.kind === 'piste' && closed.pistes.has(e.line)) return false;
    if (e.kind === 'lift' && closed.lifts.has(e.line)) return false;
  }
  if (e.kind !== 'piste' || level === 'all') return true;
  const difficulty = g.pistes[e.line].detail;
  if (difficulty === 'black') return false;
  return level !== 'easy' || difficulty !== 'red';
}

/**
 * Itinéraire le plus rapide d'un point vers la destination la plus proche (en
 * temps) parmi `targets`. `liftTargets` : viser plutôt la gare de départ de la
 * remontée la plus proche (ouverte). `closed` : tracés fermés à éviter. Null si rien n'est
 * accessible depuis ce point.
 */
export function planRoute(
  g: SkiGraph,
  from: { lng: number; lat: number },
  targets: RouteTarget[] | 'lift',
  level: SkiLevel,
  closed?: ClosedLines,
): RouteResult | null {
  const n = g.nodes.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevEdge: (Edge | null)[] = new Array(n).fill(null);
  const heap = new Heap();

  const starts = nodesNear(g, from.lng, from.lat, ATTACH_M);
  if (!starts.length) return null;
  const startWalk = new Map<number, number>();
  for (const s of starts) {
    const t = s.d / WALK_SPEED;
    if (t < best[s.node]) {
      best[s.node] = t;
      startWalk.set(s.node, s.d);
      heap.push(s.node, t);
    }
  }

  while (heap.size) {
    const [u, t] = heap.pop();
    if (t > best[u]) continue;
    for (const e of g.adj[u]) {
      if (!allowed(g, e, level, closed)) continue;
      const nt = t + e.time;
      if (nt < best[e.to]) {
        best[e.to] = nt;
        prev[e.to] = u;
        prevEdge[e.to] = e;
        heap.push(e.to, nt);
      }
    }
  }

  // Destination atteinte le plus tôt, marche finale comprise.
  let goal = -1;
  let goalTime = Infinity;
  let goalWalk = 0;
  let target: RouteTarget | null = null;
  if (targets === 'lift') {
    for (const { node, lift } of g.liftBottoms) {
      if (closed?.lifts.has(lift)) continue;
      if (best[node] < goalTime) {
        goalTime = best[node];
        goal = node;
        const l = g.lifts[lift];
        const [lng, lat] = l.coordinates[0];
        target = { id: `lift/${lift}`, name: l.name || 'Remontée', lng, lat };
      }
    }
  } else {
    for (const tg of targets) {
      for (const { node, d } of nodesNear(g, tg.lng, tg.lat, ATTACH_M)) {
        const total = best[node] + d / WALK_SPEED;
        if (total < goalTime) {
          goalTime = total;
          goal = node;
          goalWalk = d;
          target = tg;
        }
      }
    }
  }
  if (goal < 0 || !target || !Number.isFinite(goalTime)) return null;

  // Chemin à rebours, puis étapes regroupées par tracé.
  const path: { from: number; edge: Edge }[] = [];
  for (let v = goal; prev[v] >= 0; v = prev[v]) path.push({ from: prev[v], edge: prevEdge[v]! });
  path.reverse();

  const steps: RouteStep[] = [];
  const startNode = path.length ? path[0].from : goal;
  const firstWalk = startWalk.get(startNode) ?? 0;
  if (firstWalk > 0) {
    steps.push({ kind: 'walk', name: '', detail: '', distance: firstWalk, time: firstWalk / WALK_SPEED, coordinates: [[from.lng, from.lat], [g.nodes[startNode].lng, g.nodes[startNode].lat]] });
  }
  for (const { from: a, edge } of path) {
    const line = edge.kind === 'piste' ? g.pistes[edge.line] : edge.kind === 'lift' ? g.lifts[edge.line >= 0 ? edge.line : -1 - edge.line] : null;
    const name = line?.name ?? '';
    const detail = line?.detail ?? '';
    const coords =
      edge.kind === 'lift'
        ? edge.line >= 0
          ? line!.coordinates
          : [...line!.coordinates].reverse()
        : [[g.nodes[a].lng, g.nodes[a].lat], [g.nodes[edge.to].lng, g.nodes[edge.to].lat]];
    const last = steps[steps.length - 1];
    // Même piste (même nom et couleur, tronçons successifs) ou marche continue : une seule étape.
    if (last && edge.kind !== 'lift' && last.kind === edge.kind && last.name === name && last.detail === detail) {
      last.distance += edge.dist;
      last.time += edge.time;
      last.coordinates.push(coords[1]);
    } else {
      steps.push({
        kind: edge.kind,
        name,
        detail,
        distance: edge.dist,
        time: edge.time,
        coordinates: coords.map((c) => [c[0], c[1]]),
        ...(edge.kind === 'lift' && edge.line < 0 ? { descending: true } : {}),
      });
    }
  }
  if (goalWalk > 0) {
    steps.push({ kind: 'walk', name: '', detail: '', distance: goalWalk, time: goalWalk / WALK_SPEED, coordinates: [[g.nodes[goal].lng, g.nodes[goal].lat], [target.lng, target.lat]] });
  }

  return {
    target,
    time: goalTime,
    distance: steps.reduce((s, st) => s + st.distance, 0),
    steps: tidy(steps),
  };
}

/**
 * Consignes lisibles : les petites liaisons sans nom (OpenStreetMap découpe
 * les pistes en nombreux tronçons) et les quelques pas d'un tracé à l'autre
 * sont fondus dans l'étape précédente, puis les tronçons d'une même piste réunis.
 */
function tidy(steps: RouteStep[]): RouteStep[] {
  const out: RouteStep[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    const minor = (s.kind === 'walk' && s.distance < 40) || (s.kind === 'piste' && (s.distance < 60 || (!s.name && s.distance < 200)));
    const samePiste = last?.kind === 'piste' && s.kind === 'piste' && last.name === s.name && last.detail === s.detail;
    const bothWalk = last?.kind === 'walk' && s.kind === 'walk';
    if (last && last.kind !== 'lift' && (minor || samePiste || bothWalk)) {
      last.distance += s.distance;
      last.time += s.time;
      last.coordinates = last.coordinates.concat(s.coordinates.slice(1));
      continue;
    }
    out.push({ ...s, coordinates: [...s.coordinates] });
  }
  return out;
}

/** Longueur d'une ligne [lng, lat] en mètres. */
export function lineLength(coords: number[][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(
      (coords[i][0] - coords[i - 1][0]) * 111_320 * Math.cos((coords[i][1] * Math.PI) / 180),
      (coords[i][1] - coords[i - 1][1]) * METERS_PER_DEG_LAT,
    );
  }
  return total;
}

/** La ligne privée de ses `meters` premiers mètres. */
function cutStart(coords: number[][], meters: number): number[][] {
  let left = meters;
  for (let i = 1; i < coords.length; i++) {
    const d = lineLength([coords[i - 1], coords[i]]);
    if (d > left) {
      const t = left / d;
      const start = [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
      return [start, ...coords.slice(i)];
    }
    left -= d;
  }
  return coords.slice(-1);
}

/**
 * Itinéraire restant après `travelled` mètres parcourus le long du tracé :
 * étapes terminées retirées, étape en cours raccourcie (temps au prorata).
 */
export function trimRoute(route: RouteResult, travelled: number): RouteResult {
  let left = travelled;
  const steps: RouteStep[] = [];
  for (const s of route.steps) {
    const len = lineLength(s.coordinates);
    if (left >= len) {
      left -= len;
      continue;
    }
    if (left > 0 && len > 0) {
      const ratio = (len - left) / len;
      steps.push({ ...s, coordinates: cutStart(s.coordinates, left), distance: s.distance * ratio, time: s.time * ratio });
      left = 0;
    } else {
      steps.push(s);
    }
  }
  return {
    ...route,
    steps,
    time: steps.reduce((t, s) => t + s.time, 0),
    distance: steps.reduce((d, s) => d + s.distance, 0),
  };
}
