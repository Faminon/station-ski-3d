// Encodeur minimal de tuiles vectorielles (Mapbox Vector Tile 2.1), juste ce
// qu'il faut pour des polygones à un seul anneau et des propriétés texte ou
// nombre. Sert aux sapins 3D, fabriqués tuile par tuile dans un worker.

/** Résolution des coordonnées d'une tuile : celle que MapLibre utilise en interne. */
export const MVT_EXTENT = 8192;

class Writer {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(size = 64) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  varint(v: number) {
    this.ensure(10);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }

  tag(field: number, wire: 0 | 1 | 2) {
    this.varint(field * 8 + wire);
  }

  bytes(b: Uint8Array) {
    this.varint(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  double(d: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, d, true);
    this.pos += 8;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

const utf8 = new TextEncoder();
const zigzag = (n: number) => (n << 1) ^ (n >> 31);

export type PropValue = string | number;

/** Calque en cours de construction : polygones en coordonnées de tuile (0…MVT_EXTENT, y vers le bas). */
export class MvtLayer {
  private features: Uint8Array[] = [];
  private keys = new Map<string, number>();
  private values = new Map<string, number>();
  private valueList: PropValue[] = [];

  constructor(readonly name: string) {}

  get size() {
    return this.features.length;
  }

  private keyIndex(k: string) {
    let i = this.keys.get(k);
    if (i === undefined) this.keys.set(k, (i = this.keys.size));
    return i;
  }

  private valueIndex(v: PropValue) {
    const id = `${typeof v}:${v}`;
    let i = this.values.get(id);
    if (i === undefined) {
      this.values.set(id, (i = this.valueList.length));
      this.valueList.push(v);
    }
    return i;
  }

  /**
   * Ajoute un polygone d'un seul anneau, sans point de fermeture répété. L'anneau
   * extérieur doit avoir une aire positive (sens horaire à l'écran, y vers le bas).
   */
  addPolygon(ring: number[], props: Record<string, PropValue>) {
    const tags = new Writer(16);
    for (const [k, v] of Object.entries(props)) {
      tags.varint(this.keyIndex(k));
      tags.varint(this.valueIndex(v));
    }
    const n = ring.length / 2;
    const geom = new Writer(8 + n * 4);
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0) geom.varint((1 << 3) | 1); // MoveTo ×1
      if (i === 1) geom.varint(((n - 1) << 3) | 2); // LineTo ×(n-1)
      const x = Math.round(ring[i * 2]);
      const y = Math.round(ring[i * 2 + 1]);
      geom.varint(zigzag(x - cx));
      geom.varint(zigzag(y - cy));
      cx = x;
      cy = y;
    }
    geom.varint((1 << 3) | 7); // ClosePath

    const f = new Writer(32 + geom.pos);
    f.tag(2, 2);
    f.bytes(tags.finish());
    f.tag(3, 0);
    f.varint(3); // POLYGON
    f.tag(4, 2);
    f.bytes(geom.finish());
    this.features.push(f.finish());
  }

  encode(w: Writer) {
    w.tag(15, 0);
    w.varint(2);
    w.tag(1, 2);
    w.bytes(utf8.encode(this.name));
    for (const f of this.features) {
      w.tag(2, 2);
      w.bytes(f);
    }
    for (const k of this.keys.keys()) {
      w.tag(3, 2);
      w.bytes(utf8.encode(k));
    }
    for (const v of this.valueList) {
      const val = new Writer(16);
      if (typeof v === 'string') {
        val.tag(1, 2);
        val.bytes(utf8.encode(v));
      } else {
        val.tag(3, 1);
        val.double(v);
      }
      w.tag(4, 2);
      w.bytes(val.finish());
    }
    w.tag(5, 0);
    w.varint(MVT_EXTENT);
  }
}

/** Tuile complète (calques non vides seulement), prête à être transférée. */
export function encodeTile(layers: MvtLayer[]): ArrayBuffer {
  const tile = new Writer(1024);
  for (const layer of layers) {
    if (!layer.size) continue;
    const w = new Writer(1024);
    layer.encode(w);
    tile.tag(3, 2);
    tile.bytes(w.finish());
  }
  const out = tile.finish();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
