// Snowparks et zones ludiques de la carte Three.js, comme sur la carte MapLibre :
// - zones peintes sur le relief, dans une texture par tuile (orange translucide, contour en
//   pointillés ; bande large le long d'un parc connu par son tracé) ;
// - nom du parc (« SNOWPARK »), en étiquette ;
// - sauts, rails, box et entrée en 3D (parkFeatures.ts, mêmes modules que la carte MapLibre).
//
// Texture de données, pas d'image : canal rouge = couverture « snowpark », vert = « zone
// ludique » (0 à 1), sur fond noir opaque ; le relief mêle lui-même la couleur (terrain.ts).

import * as THREE from 'three/webgpu';
import type { FeatureCollection } from 'geojson';
import { PARK_COLORS } from '@/components/domain/parkZones';
import { mercX, mercY } from './geo';
import { PARK_OVERLAY_SIZE } from './terrain';

export { PARK_COLORS };

/** Opacités : surface (un peu plus franche que la carte MapLibre), contour, bande d'un tracé. */
const FILL = 0.5;
const OUTLINE = 1;
const RUN = 0.5;
/** Largeur de la bande d'un parc connu par son tracé (m), contour (m) et pointillés (m). */
const RUN_WIDTH_M = 200;
const OUTLINE_WIDTH_M = 5;
const DASH_M: [number, number] = [14, 8];
/** Assez fin pour des bords nets (voir terrain.ts). */
const SIZE = PARK_OVERLAY_SIZE;

/**
 * Peintre des zones de parc pour une tuile (z, x, y) : texture de couverture, ou null si aucune
 * zone ne la touche.
 */
export function parkOverlay(zones: FeatureCollection) {
  const shapes = zones.features.filter((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'LineString');
  return (z: number, x: number, y: number, metersPerPixel: number): THREE.Texture | null => {
    const n = 2 ** z;
    const px = (lng: number) => (mercX(lng) * n - x) * SIZE;
    const py = (lat: number) => (mercY(lat) * n - y) * SIZE;
    const touches = (coords: number[][]) => coords.some(([lng, lat]) => px(lng) > -SIZE * 0.2 && px(lng) < SIZE * 1.2 && py(lat) > -SIZE * 0.2 && py(lat) < SIZE * 1.2);
    const mine = shapes.filter((f) => touches(f.geometry.type === 'Polygon' ? (f.geometry as GeoJSON.Polygon).coordinates[0] : (f.geometry as GeoJSON.LineString).coordinates));
    if (!mine.length) return null;

    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Les couvertures s'additionnent (surface + contour), plafonnées à 1.
    ctx.globalCompositeOperation = 'lighter';
    const ink = (kind: unknown, amount: number) => (kind === 'playground' ? `rgb(0,${Math.round(255 * amount)},0)` : `rgb(${Math.round(255 * amount)},0,0)`);
    const path = (coords: number[][], close: boolean) => {
      ctx.beginPath();
      coords.forEach(([lng, lat], i) => (i ? ctx.lineTo(px(lng), py(lat)) : ctx.moveTo(px(lng), py(lat))));
      if (close) ctx.closePath();
    };
    for (const f of mine) {
      const kind = f.properties?.kind;
      if (f.geometry.type === 'Polygon') {
        path(f.geometry.coordinates[0], true);
        ctx.fillStyle = ink(kind, FILL);
        ctx.fill();
        ctx.setLineDash(DASH_M.map((m) => m / metersPerPixel));
        ctx.lineWidth = OUTLINE_WIDTH_M / metersPerPixel;
        ctx.strokeStyle = ink(kind, OUTLINE - FILL);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (f.geometry.type === 'LineString') {
        path(f.geometry.coordinates, false);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = RUN_WIDTH_M / metersPerPixel;
        ctx.strokeStyle = ink(kind, RUN);
        ctx.stroke();
      }
    }
    const tex = new THREE.Texture(canvas.transferToImageBitmap());
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  };
}

/** Points d'étiquette des parcs (sortie de parkZoneFeatures : un point par parc). */
export function parkLabelPoints(zones: FeatureCollection): { lng: number; lat: number; label: string }[] {
  return zones.features.flatMap((f) =>
    f.geometry.type === 'Point' ? [{ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: String(f.properties?.label ?? 'Snowpark') }] : [],
  );
}
