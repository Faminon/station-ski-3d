'use client';

import { useEffect } from 'react';

/**
 * Gestes sur une carte plein écran : ils vont à la carte, jamais à la page.
 *
 * - Glissé vers le bas : la page ne se recharge plus (« tirer pour rafraîchir » de Chrome Android
 *   et des WebView) et ne rebondit plus (Safari).
 * - Pincement : la page ne zoome plus. Safari iOS ignore `user-scalable=no` (voir mapViewport) :
 *   ses gestes de zoom sont annulés ici. Pincé sur un trackpad (molette + Ctrl) au-dessus d'une
 *   pastille, d'un nom ou du panneau, le zoom est renvoyé à la carte au lieu d'agrandir la page.
 *
 * Réglages posés le temps de la carte seulement : les autres pages se comportent normalement.
 */
export function useMapGestures() {
  useEffect(() => {
    const targets = [document.documentElement, document.body];
    const saved = targets.map((el) => el.style.overscrollBehavior);
    for (const el of targets) el.style.overscrollBehavior = 'none';

    const cancel = (e: Event) => e.preventDefault();
    // Safari (iOS et macOS) : gestes de zoom propres au navigateur.
    document.addEventListener('gesturestart', cancel);
    document.addEventListener('gesturechange', cancel);

    // Pincement au trackpad ou Ctrl + molette : toujours pour la carte. Molette simple au-dessus
    // d'une pastille ou d'un nom posé sur la carte : pour la carte aussi (sinon, rien ne zoome).
    const onMarker = (t: EventTarget | null) => t instanceof Element && !!t.closest('.three-poi, .three-village, .three-closed, .three-peak, .three-here, .maplibregl-marker');
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !onMarker(e.target)) return;
      e.preventDefault();
      const canvas = document.querySelector('canvas');
      if (!canvas || e.target === canvas) return;
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    window.addEventListener('wheel', onWheel, { passive: false });

    // Deux doigts posés hors de la carte (pastille, panneau) : pas de zoom de la page non plus.
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener('touchmove', onTouch, { passive: false });

    return () => {
      targets.forEach((el, i) => (el.style.overscrollBehavior = saved[i]));
      document.removeEventListener('gesturestart', cancel);
      document.removeEventListener('gesturechange', cancel);
      window.removeEventListener('wheel', onWheel);
      document.removeEventListener('touchmove', onTouch);
    };
  }, []);
}
