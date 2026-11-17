'use client';

import { useEffect, useState } from 'react';

/**
 * Clavier du téléphone ouvert : hauteur qu'il cache en bas de l'écran (px) et hauteur encore
 * visible, d'après le « visual viewport ». Sert à remonter seulement la fiche où l'on tape, au
 * lieu de laisser le navigateur faire glisser toute la page (Safari iOS surtout).
 */
export function useKeyboardInset(): { inset: number; visibleHeight: number | null } {
  const [state, setState] = useState<{ inset: number; visibleHeight: number | null }>({ inset: 0, visibleHeight: null });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setState({ inset, visibleHeight: inset > 40 ? Math.round(vv.height) : null });
      // La page reste en place : seul l'élément concerné remonte.
      if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return state;
}
