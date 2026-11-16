import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ThreeClient from '@/components/three/ThreeClient';
import { SKI_DOMAINS, skiDomain } from '@/lib/skiDomains';

// Une page par domaine, produite à la construction.
export const dynamicParams = false;
export const generateStaticParams = () => SKI_DOMAINS.map((d) => ({ domaine: d.slug }));

export async function generateMetadata({ params }: { params: Promise<{ domaine: string }> }): Promise<Metadata> {
  const { domaine } = await params;
  const domain = skiDomain(domaine);
  return {
    title: domain ? `${domain.name} en 3D (Three.js) — AltiStay` : 'Carte 3D (Three.js) — AltiStay',
    // Version d'essai, à comparer avec la carte MapLibre (/carte/…) : pas dans les moteurs de recherche.
    robots: { index: false, follow: false },
  };
}

/** Carte 3D d'un domaine en Three.js (moteur WebGPU) : /three/foret-blanche. */
export default async function ThreeDomainRoute({ params }: { params: Promise<{ domaine: string }> }) {
  const { domaine } = await params;
  const domain = skiDomain(domaine);
  if (!domain) notFound();
  return <ThreeClient domain={domain} />;
}
