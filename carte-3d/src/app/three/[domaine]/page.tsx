import { redirect } from 'next/navigation';
import { SKI_DOMAINS } from '@/lib/skiDomains';

// Ancienne adresse de la version d'essai Three.js : la carte est désormais sur /carte/<domaine>.
export const dynamicParams = false;
export const generateStaticParams = () => SKI_DOMAINS.map((d) => ({ domaine: d.slug }));

export default async function ThreeDomainRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ domaine: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { domaine } = await params;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const one of [v].flat()) if (one !== undefined) query.append(k, one);
  const qs = query.toString();
  redirect(`/carte/${domaine}${qs ? `?${qs}` : ''}`);
}
