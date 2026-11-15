import { skiDomain } from '@/lib/skiDomains';
import { loadLiveConditions } from '@/lib/live/liveConditions';

/**
 * Conditions en direct d'un domaine : /api/live/foret-blanche (voir src/lib/live).
 * Chaque source a son propre cache côté serveur (de 1 à 30 minutes) ; la réponse
 * elle-même peut être gardée une minute par un CDN.
 */
/**
 * Lisible depuis d'autres origines : la carte embarquée dans l'appli mobile d'une station
 * (paquet hors ligne, src/lib/offlinePack.ts) est servie par le téléphone lui-même. Données
 * publiques, lues sans cookie ni identifiant.
 */
const CORS = { 'Access-Control-Allow-Origin': '*' };

export async function GET(request: Request, { params }: { params: Promise<{ domaine: string }> }) {
  const { domaine } = await params;
  const domain = skiDomain(domaine);
  const url = new URL(request.url);
  // ?demo=saison : jour de pleine saison simulé (src/lib/live/demoSeason.ts), pour voir le rendu.
  const live = domain ? await loadLiveConditions(domain, url.origin, url.searchParams.get('demo') === 'saison') : null;
  if (!live) return Response.json({ error: 'Pas de conditions en direct pour ce domaine.' }, { status: 404, headers: CORS });
  return Response.json(live, {
    headers: {
      ...CORS,
      // Le navigateur redemande à chaque fois (la carte relit toutes les 2 minutes) ; un CDN peut
      // garder la réponse une minute.
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
