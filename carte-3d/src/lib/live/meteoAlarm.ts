// MeteoAlarm (réseau des services météo européens) : vigilances en cours, flux Atom par
// pays, sans clé. Pour la France, ce sont celles de Météo-France (jaune et plus), par
// département. Sert de repli quand la clé Météo-France n'est pas configurée : couleur et
// phénomènes de la vigilance, dont les avalanches (mais pas l'indice 1 à 5 du bulletin).

import type { VigilanceColor } from './types';
import { fetchText } from './http';

const FEED = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france';

const COLORS: Record<string, VigilanceColor> = { green: 1, yellow: 2, orange: 3, red: 4 };

/** Types de vigilance de MeteoAlarm, en français (libellés de Météo-France). */
const TYPES: [RegExp, string][] = [
  [/avalanche/i, 'Avalanches'],
  [/snow|ice/i, 'Neige-verglas'],
  [/wind/i, 'Vent violent'],
  [/thunder/i, 'Orages'],
  [/flood/i, 'Crues'],
  [/rain/i, 'Pluie-inondation'],
  [/high.?temp|heat/i, 'Canicule'],
  [/low.?temp|cold/i, 'Grand froid'],
  [/coastal|wave/i, 'Vagues-submersion'],
  [/fog/i, 'Brouillard'],
  [/forest.?fire/i, 'Feux de forêt'],
];

export interface MeteoAlarmResult {
  color: VigilanceColor;
  phenomena: { label: string; color: VigilanceColor }[];
  updatedAt?: string;
  servedAt: string;
}

/** Vigilances en cours (non expirées) d'un département, repéré par son code NUTS 3 ou son nom. */
export function parseMeteoAlarm(xml: string, nuts3: string, area: string, now = Date.now()): Omit<MeteoAlarmResult, 'servedAt'> {
  const phenomena = new Map<string, VigilanceColor>();
  let updatedAt: string | undefined;
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const code = /<valueName>NUTS3<\/valueName>\s*<value>([^<]*)<\/value>/.exec(entry)?.[1];
    const name = /<cap:areaDesc>([^<]*)<\/cap:areaDesc>/.exec(entry)?.[1];
    if (code !== nuts3 && name !== area) continue;
    const expires = Date.parse(/<cap:expires>([^<]*)</.exec(entry)?.[1] ?? '');
    if (!Number.isNaN(expires) && expires < now) continue;
    // « Yellow Avalanches Warning issued for France - Hautes-Alpes »
    const title = /<title>([^<]*)<\/title>/.exec(entry)?.[1] ?? '';
    const color = COLORS[title.split(' ')[0]?.toLowerCase() ?? ''];
    const label = TYPES.find(([re]) => re.test(title))?.[1];
    if (!color || !label) continue;
    if (color > (phenomena.get(label) ?? 0)) phenomena.set(label, color);
    const updated = /<updated>([^<]*)<\/updated>/.exec(entry)?.[1];
    if (updated && (!updatedAt || updated > updatedAt)) updatedAt = updated;
  }
  const list = [...phenomena].map(([label, color]) => ({ label, color })).filter((p) => p.color > 1).sort((a, b) => b.color - a.color);
  return { color: (list[0]?.color ?? 1) as VigilanceColor, phenomena: list, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined };
}

export async function fetchMeteoAlarm(nuts3: string, area: string): Promise<MeteoAlarmResult | null> {
  const res = await fetchText(FEED, { revalidate: 600 });
  // Flux vide ou d'un autre format : pas de repli plutôt qu'un « tout va bien » trompeur.
  if (!res || !res.text.includes('<feed')) return null;
  return { ...parseMeteoAlarm(res.text, nuts3, area), servedAt: res.servedAt };
}
