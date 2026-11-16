'use client';

// Bulles de la carte du domaine (clic sur un lieu, une piste ou une remontée), rendues par
// React dans une bulle MapLibre. Les fiches elles-mêmes sont dans MapCards.tsx.

import { createRoot } from 'react-dom/client';
import { Popup, type Map as MlMap } from 'maplibre-gl';

/** Ouvre une bulle dont le contenu est un composant React ; démontée à la fermeture. */
export function openReactPopup(map: MlMap, lngLat: [number, number], render: (close: () => void) => React.ReactNode): Popup {
  const el = document.createElement('div');
  const root = createRoot(el);
  const popup = new Popup({ offset: 18, maxWidth: '300px', closeButton: false, className: 'alti-popup', focusAfterOpen: false });
  root.render(render(() => popup.remove()));
  popup.on('close', () => setTimeout(() => root.unmount(), 0));
  return popup.setLngLat(lngLat).setDOMContent(el).addTo(map);
}

export { PlaceCard, TrackCard } from './MapCards';
