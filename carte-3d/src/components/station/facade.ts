// Couleur de façade d'un bâtiment de village, stable d'un affichage à l'autre, tirée de sa
// forme. Partagée par les cartes MapLibre (map3d.ts) et Three.js (sans dépendre de MapLibre).

const FACADE_COLORS = ['#c9a27e', '#b98b62', '#d8c3a5', '#e8dcc6', '#a9a39a', '#cfc6b8', '#d9b48f', '#bfa58a'];

export function facadeColor(ring: [number, number][]): string {
  const seed = Math.abs(Math.round((ring[0][0] + ring[0][1]) * 1e5) + ring.length);
  return FACADE_COLORS[seed % FACADE_COLORS.length];
}
