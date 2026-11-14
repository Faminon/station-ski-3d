import type { Metadata } from 'next';
import DomainMapPage, { domainMapMetadata } from '@/components/domain/DomainMapPage';
import { SKI_DOMAINS } from '@/lib/skiDomains';

// Les données sont des fichiers de public/data : une page par domaine, produite à la construction.
export const dynamicParams = false;
export const generateStaticParams = () => SKI_DOMAINS.map((d) => ({ domaine: d.slug }));

export async function generateMetadata({ params }: { params: Promise<{ domaine: string }> }): Promise<Metadata> {
  const { domaine } = await params;
  return domainMapMetadata(domaine);
}

/** Carte 3D d'un domaine : /carte/3-vallees, /carte/foret-blanche… (voir src/lib/skiDomains.ts). */
export default async function DomainMapRoute({ params }: { params: Promise<{ domaine: string }> }) {
  const { domaine } = await params;
  return <DomainMapPage slug={domaine} />;
}
