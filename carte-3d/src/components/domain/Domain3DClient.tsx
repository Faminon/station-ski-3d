'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import type { PisteStats } from '@/lib/pisteStats';
import type { SkiDomainConfig } from '@/lib/skiDomains';
import type { BuiltArea } from './mountainBuildings';

// MapLibre (WebGL) ne fonctionne que dans le navigateur.
const Domain3DViewer = dynamic(() => import('./Domain3DViewer'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-winter-900 text-white">
      <Loader2 className="mb-4 h-8 w-8 animate-spin text-white/80" />
      <p className="font-display text-2xl">Carte 3D du domaine</p>
      <p className="mt-1 text-sm text-white/60">Chargement…</p>
    </div>
  ),
});

export default function Domain3DClient(props: {
  domain: SkiDomainConfig;
  stats: PisteStats | null;
  stationIds: string[];
  villageIds: string[];
  builtAreas: BuiltArea[];
  embedded?: boolean;
}) {
  return <Domain3DViewer {...props} />;
}
