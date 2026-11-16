// Repère de la carte Three.js : mètres autour du centre du domaine, x vers l'est,
// y vers le haut (altitude × exagération du relief), z vers le sud.
//
// Projection de Mercator ramenée à l'échelle réelle au centre (× cos latitude) : les
// tuiles {z}/{x}/{y} y sont des carrés alignés sur les axes, les distances sont justes
// à quelques millièmes près sur toute l'étendue d'un domaine.

export const EARTH_CIRCUMFERENCE = 40_075_016.686;

/** Relief accentué de 20 %, comme sur la carte MapLibre (map3d.ts). */
export const EXAGGERATION = 1.2;

export const mercX = (lng: number) => (lng + 180) / 360;
export const mercY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

export interface Frame {
  /** Mètres par unité de Mercator (0 à 1). */
  scale: number;
  mx0: number;
  my0: number;
  /** Longitude, latitude → x, z (m). */
  toXZ(lng: number, lat: number): [number, number];
  /** Coordonnées de Mercator (0 à 1) → x, z (m). */
  mercToXZ(mx: number, my: number): [number, number];
  /** x, z (m) → coordonnées de Mercator (0 à 1). */
  xzToMerc(x: number, z: number): [number, number];
  /** x, z (m) → longitude, latitude. */
  toLngLat(x: number, z: number): [number, number];
  /** Coins nord-ouest et sud-est de la tuile (z, x, y) : [x0, z0, x1, z1] (m). */
  tileRect(z: number, x: number, y: number): [number, number, number, number];
}

export function makeFrame(lng0: number, lat0: number): Frame {
  const scale = EARTH_CIRCUMFERENCE * Math.cos((lat0 * Math.PI) / 180);
  const mx0 = mercX(lng0);
  const my0 = mercY(lat0);
  const mercToXZ = (mx: number, my: number): [number, number] => [(mx - mx0) * scale, (my - my0) * scale];
  return {
    scale,
    mx0,
    my0,
    toXZ: (lng, lat) => mercToXZ(mercX(lng), mercY(lat)),
    mercToXZ,
    xzToMerc: (x, z) => [mx0 + x / scale, my0 + z / scale],
    toLngLat(x, z) {
      const mx = mx0 + x / scale;
      const my = my0 + z / scale;
      return [mx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI];
    },
    tileRect(z, x, y) {
      const n = 2 ** z;
      const [x0, z0] = mercToXZ(x / n, y / n);
      const [x1, z1] = mercToXZ((x + 1) / n, (y + 1) / n);
      return [x0, z0, x1, z1];
    },
  };
}

/** Tuiles (x, y) du zoom z qui recouvrent l'emprise [ouest, sud, est, nord]. */
export function tilesCovering(bounds: [number, number, number, number], z: number): [number, number][] {
  const n = 2 ** z;
  const x0 = Math.floor(mercX(bounds[0]) * n);
  const x1 = Math.floor(mercX(bounds[2]) * n);
  const y0 = Math.floor(mercY(bounds[3]) * n);
  const y1 = Math.floor(mercY(bounds[1]) * n);
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
