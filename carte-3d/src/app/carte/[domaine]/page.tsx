import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { mapViewport } from '@/lib/mapViewport';
import { domainMapMetadata } from '@/components/domain/DomainMapPage';
import ThreeClient from '@/components/three/ThreeClient';
import { SKI_DOMAINS, skiDomain } from '@/lib/skiDomains';

// Les données sont des fichiers de public/data : une page par domaine, produite à la construction.
export const dynamicParams = false;
export const viewport = mapViewport;
export const generateStaticParams = () => SKI_DOMAINS.map((d) => ({ domaine: d.slug }));

export async function generateMetadata({ params }: { params: Promise<{ domaine: string }> }): Promise<Metadata> {
  const { domaine } = await params;
  return domainMapMetadata(domaine);
}

/** Carte 3D d'un domaine (Three.js) : /carte/3-vallees, /carte/foret-blanche… (voir src/lib/skiDomains.ts). */
export default async function DomainMapRoute({ params }: { params: Promise<{ domaine: string }> }) {
  const { domaine } = await params;
  const domain = skiDomain(domaine);
  if (!domain) notFound();
  return <ThreeClient domain={domain} />;
}
