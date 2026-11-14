import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Domain3DClient from '@/components/domain/Domain3DClient';
import { loadDomainData } from '@/lib/domainData';
import { skiDomain } from '@/lib/skiDomains';

export function domainMapMetadata(slug: string): Metadata {
  const domain = skiDomain(slug);
  if (!domain) return { title: 'Carte 3D — AltiStay' };
  return {
    title: `${domain.name} en 3D — AltiStay`,
    description: `Carte 3D du domaine ${domain.name} : relief, pistes, remontées, lieux, itinéraires et guidage GPS.`,
  };
}

/** Carte 3D plein écran d'un domaine relié, sans barre de navigation ni pied de page. */
export default function DomainMapPage({ slug, embedded = false }: { slug: string; embedded?: boolean }) {
  const domain = skiDomain(slug);
  if (!domain || (embedded && !domain.embed)) notFound();
  const data = loadDomainData(domain);
  if (!data) notFound();

  return (
    <Domain3DClient
      domain={domain}
      stats={data.stats}
      stationIds={data.stations.map((s) => s.id)}
      villageIds={data.stations.filter((s) => s.village).map((s) => s.id)}
      // Villages dont les bâtiments réels sont fournis : leurs lieux n'ont pas besoin de bâtiment dessiné.
      builtAreas={data.builtAreas}
      embedded={embedded}
    />
  );
}
