'use client';

import { useEffect, useState } from 'react';
import type { LiveConditions } from '@/lib/live/types';
import { isOffline, offlinePack } from '@/lib/offlinePack';

/** Rafraîchissement des conditions en direct (les sources ont leur propre cache côté serveur). */
const REFRESH_MS = 120_000;
/** Dernières conditions reçues, gardées sur l'appareil pour les montrer sans réseau (12 h au plus). */
const STORE_KEY = 'carte3d-direct-';
const STORE_MAX_AGE_MS = 12 * 3600_000;

function remember(slug: string, data: LiveConditions) {
  try {
    window.localStorage.setItem(STORE_KEY + slug, JSON.stringify(data));
  } catch {
    // Stockage plein ou refusé : rien de grave, seule la reprise sans réseau s'en passe.
  }
}

function recall(slug: string): LiveConditions | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY + slug);
    const data = raw ? (JSON.parse(raw) as LiveConditions) : null;
    return data && Date.now() - Date.parse(data.generatedAt) < STORE_MAX_AGE_MS ? data : null;
  } catch {
    return null;
  }
}

export interface LiveState {
  /** Dernières conditions reçues (gardées si un rafraîchissement échoue). */
  data: LiveConditions | null;
  /** Le dernier appel a échoué : les données affichées datent du précédent, ou manquent. */
  failed: boolean;
}

/**
 * Conditions en direct du domaine, relues toutes les 2 minutes tant que l'onglet est
 * visible (aucun appel en arrière-plan) et dès qu'il redevient visible.
 */
/** `demo` : jour de pleine saison simulé (voir src/lib/live/demoSeason.ts). */
export function useLiveConditions(slug: string, enabled: boolean, demo = false): LiveState {
  const [state, setState] = useState<LiveState>({ data: null, failed: false });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let last = 0;

    const load = async () => {
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      last = Date.now();
      try {
        // Appli mobile (paquet hors ligne) : la page vient du téléphone, les conditions du site.
        if (offlinePack() && isOffline()) throw new Error('Hors ligne');
        const base = offlinePack()?.site ?? '';
        const res = await fetch(`${base}/api/live/${slug}${demo ? '?demo=saison' : ''}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as LiveConditions;
        setState({ data, failed: false });
        if (!demo) remember(slug, data);
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        // Sans réseau dès l'ouverture : les dernières conditions reçues sur l'appareil, avec leur heure.
        setState((s) => ({ data: s.data ?? (demo ? null : recall(slug)), failed: true }));
      }
      if (document.visibilityState === 'visible') timer = setTimeout(load, REFRESH_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        clearTimeout(timer);
        return;
      }
      // De retour sur l'onglet : relu si la dernière lecture date, sinon reprise du rythme normal.
      const age = Date.now() - last;
      clearTimeout(timer);
      timer = setTimeout(load, Math.max(0, REFRESH_MS / 2 - age));
    };

    void load();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [slug, enabled, demo]);

  return state;
}
