import type { Viewport } from 'next';

/**
 * Pages de carte plein écran : pas de zoom de la page au pincement, la carte zoome seule
 * (Chrome Android, WebView ; Safari iOS est géré dans useMapGestures).
 */
export const mapViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Clavier ouvert (Chrome Android) : l'écran utile rétrécit au lieu que la page glisse sous lui.
  interactiveWidget: 'resizes-content',
};
