// Altitude du terrain en un point, lue dans les tuiles d'altitude « Terrain
// Tiles » (format terrarium, les mêmes que le relief 3D). Sert à orienter les
// pistes pour le calcul d'itinéraire : OpenStreetMap ne garantit pas le sens
// de tracé d'une piste, l'altitude de ses deux bouts le donne.
//
// Zoom 12 : un pixel couvre une vingtaine de mètres dans les Alpes, largement
// assez pour savoir de quel côté une piste descend, et une vingtaine de tuiles
// suffisent pour tout le domaine.

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ZOOM = 12;
const SIZE = 256;

function tileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
  return [x, y];
}

export interface TerrainSampler {
  /** Altitude en mètres (réelle, sans l'exagération du relief affiché), ou null hors des tuiles chargées. */
  elevation(lng: number, lat: number): number | null;
}

async function loadTile(x: number, y: number): Promise<Uint8ClampedArray> {
  const res = await fetch(TILE_URL.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y)));
  if (!res.ok) throw new Error(`Tuile d'altitude ${x}/${y} : HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

/** Charge les tuiles couvrant l'emprise [ouest, sud, est, nord] et renvoie un lecteur d'altitude synchrone. */
export async function loadTerrain(bbox: [number, number, number, number]): Promise<TerrainSampler> {
  const [w, s, e, n] = bbox;
  const [x0, y0] = tileXY(w, n, ZOOM).map(Math.floor);
  const [x1, y1] = tileXY(e, s, ZOOM).map(Math.floor);
  const tiles = new Map<string, Uint8ClampedArray>();
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(loadTile(x, y).then((data) => void tiles.set(`${x}/${y}`, data)));
    }
  }
  await Promise.all(jobs);

  return {
    elevation(lng, lat) {
      const [fx, fy] = tileXY(lng, lat, ZOOM);
      const data = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
      if (!data) return null;
      // Interpolation entre les 4 pixels voisins : en pente raide, un pixel entier fausse l'altitude de plusieurs mètres.
      const gx = Math.min(SIZE - 1.001, Math.max(0, (fx % 1) * SIZE - 0.5));
      const gy = Math.min(SIZE - 1.001, Math.max(0, (fy % 1) * SIZE - 0.5));
      const [x0, y0] = [Math.floor(gx), Math.floor(gy)];
      const [tx, ty] = [gx - x0, gy - y0];
      // Terrarium : altitude = R × 256 + V + B / 256 − 32 768.
      const at = (x: number, y: number) => {
        const i = (y * SIZE + x) * 4;
        return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
      };
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      return top * (1 - ty) + bottom * ty;
    },
  };
}
