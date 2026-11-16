'use client';

import dynamic from 'next/dynamic';
import type { SkiDomainConfig } from '@/lib/skiDomains';

// Three.js (WebGPU / WebGL 2) ne fonctionne que dans le navigateur.
const ThreeViewer = dynamic(() => import('./ThreeViewer'), { ssr: false });

export default function ThreeClient({ domain }: { domain: SkiDomainConfig }) {
  return <ThreeViewer domain={domain} />;
}
