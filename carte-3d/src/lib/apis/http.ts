// Client HTTP partagé par toutes les intégrations d'APIs publiques.
// Toutes les APIs branchées ici proviennent de github.com/public-apis/public-apis
// et sont utilisables SANS clé (colonne Auth = "No"), donc rien à ajouter dans .env.
//
// Règles communes :
//  - jamais d'exception qui remonte : un service tiers indisponible ne doit pas
//    casser une page (on renvoie null, l'appelant applique son fallback) ;
//  - timeout dur pour ne pas bloquer le rendu serveur ;
//  - cache Next.js (`next.revalidate`) pour rester dans les quotas de courtoisie
//    des services communautaires (Nominatim, Open Topo Data...).

/** User-Agent identifiant : exigé par la politique d'usage de Nominatim/OSM. */
export const API_USER_AGENT =
  'AltiStay/0.1 (comparateur de sejours en station; +https://github.com/public-apis/public-apis)';

export interface FetchJsonOptions {
  /** Durée de cache Next.js en secondes. 0 = pas de cache. */
  revalidate?: number;
  /** Tags de cache pour une invalidation ciblée via revalidateTag(). */
  tags?: string[];
  /** Abandon de la requête au-delà de ce délai (ms). */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T | null> {
  const { revalidate = 3600, tags, timeoutMs = 8000, headers } = options;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': API_USER_AGENT,
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
      next: revalidate > 0 ? { revalidate, ...(tags ? { tags } : {}) } : undefined,
      ...(revalidate > 0 ? {} : { cache: 'no-store' as RequestCache }),
    });

    if (!res.ok) {
      console.warn(`[apis] ${new URL(url).host} a répondu ${res.status} sur ${url}`);
      return null;
    }

    return (await res.json()) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[apis] échec de l'appel à ${url} : ${reason}`);
    return null;
  }
}

/** Construit une URL avec query string en ignorant les valeurs vides. */
export function buildUrl(base: string, params: Record<string, string | number | undefined | null>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
