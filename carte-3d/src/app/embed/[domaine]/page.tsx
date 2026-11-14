import type { Metadata } from 'next';
import DomainMapPage, { domainMapMetadata } from '@/components/domain/DomainMapPage';
import { SKI_DOMAINS } from '@/lib/skiDomains';

// Une page par domaine intégrable, produite à la construction.
export const dynamicParams = false;
export const generateStaticParams = () => SKI_DOMAINS.filter((d) => d.embed).map((d) => ({ domaine: d.slug }));

export async function generateMetadata({ params }: { params: Promise<{ domaine: string }> }): Promise<Metadata> {
  const { domaine } = await params;
  // Version à intégrer : la carte plein écran (/carte/…) est celle à référencer.
  return { ...domainMapMetadata(domaine), robots: { index: false, follow: false } };
}

/**
 * Carte 3D à intégrer dans le site d'une station, en iframe : /embed/foret-blanche…
 * Seuls les sites listés dans `embed.allowedOrigins` (src/lib/skiDomains.ts) peuvent
 * l'afficher : l'en-tête `frame-ancestors` est posé par src/proxy.ts.
 */
export default async function EmbedDomainMapRoute({ params }: { params: Promise<{ domaine: string }> }) {
  const { domaine } = await params;
  return <DomainMapPage slug={domaine} embedded />;
}
