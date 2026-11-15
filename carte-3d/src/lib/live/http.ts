// Appel d'un service des conditions en direct : texte brut (XML, JSON) et heure à
// laquelle le service l'a servi. Même règles que src/lib/apis/http.ts : jamais
// d'exception (null si le service ne répond pas), délai maximal, cache Next.js.

import { API_USER_AGENT } from '@/lib/apis/http';

export interface FetchedText {
  text: string;
  /** Heure de la réponse du service (en-tête Date, conservé par le cache), ISO. */
  servedAt: string;
}

export async function fetchText(
  url: string,
  { revalidate, headers, timeoutMs = 8000 }: { revalidate: number; headers?: Record<string, string>; timeoutMs?: number },
): Promise<FetchedText | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': API_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate },
    });
    if (!res.ok) {
      console.warn(`[live] ${new URL(url).host} a répondu ${res.status}`);
      return null;
    }
    // Encodage annoncé par le service, ou dans l'en-tête XML (certains bulletins sont en ISO-8859-1).
    const bytes = await res.arrayBuffer();
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 200));
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? /encoding="([\w-]+)"/i.exec(head)?.[1] ?? 'utf-8';
    let text: string;
    try {
      text = new TextDecoder(charset).decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    const date = Date.parse(res.headers.get('date') ?? '');
    return { text, servedAt: new Date(Number.isNaN(date) ? Date.now() : date).toISOString() };
  } catch (error) {
    console.warn(`[live] échec de l'appel à ${new URL(url).host} : ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function parseJson<T>(fetched: FetchedText | null): T | null {
  if (!fetched) return null;
  try {
    return JSON.parse(fetched.text) as T;
  } catch {
    return null;
  }
}

/** Heure locale française sans fuseau (« 2026-11-14T16:00:00 », bulletins Météo-France, Open-Meteo) → ISO. */
export function parisTimeToIso(local: string | undefined): string | undefined {
  if (!local) return undefined;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(local)) return new Date(local).toISOString();
  const asUtc = Date.parse(`${local}Z`);
  if (Number.isNaN(asUtc)) return undefined;
  // Décalage de Paris à cette date (+01:00 l'hiver, +02:00 l'été).
  const name = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' })
    .formatToParts(new Date(asUtc))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(name ?? '');
  const offset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 60;
  return new Date(asUtc - offset * 60_000).toISOString();
}
