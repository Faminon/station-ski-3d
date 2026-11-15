// Météo-France, portail des API publiques (portail-api.meteofrance.fr) : bulletin
// d'estimation du risque d'avalanche (« DonneesPubliquesBRA », un bulletin par massif,
// publié vers 16 h de début novembre à fin mai) et vigilance météorologique
// (« DonneesPubliquesVigilance »). Gratuites, mais il faut une clé : créer un compte sur
// le portail, s'abonner aux deux API et générer une clé d'API (METEOFRANCE_API_KEY dans
// .env.local). Sans clé, ces fonctions renvoient null et la carte se replie sur MeteoAlarm.
//
// Format du bulletin : « Descriptif technique des informations du bulletin avalanche »,
// Météo-France, version du 26/10/2023.

import type { VigilanceColor } from './types';
import { fetchText, parisTimeToIso, parseJson } from './http';

const API = 'https://public-api.meteofrance.fr/public';

const apiKey = () => process.env.METEOFRANCE_API_KEY?.trim() || null;
export const hasMeteoFranceKey = () => apiKey() !== null;

// ---- Lecture du XML (structure fixe, sans dépendance) -------------------------------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (v: string) =>
  v.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/** Attributs de la première balise `tag` du texte. */
function attrs(xml: string, tag: string): Record<string, string> | null {
  const m = new RegExp(`<${tag}\\b([^>]*)>`).exec(xml);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) out[a[1]] = decode(a[2]);
  return out;
}

const text = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decode(m[1]).trim() : undefined;
};

const num = (v: string | undefined) => (v === undefined || v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---- Bulletin avalanche --------------------------------------------------------------------

export interface BraBulletin {
  massif: string;
  issuedAt?: string;
  validUntil?: string;
  risk: number | null;
  levels: { label: string; risk: number }[];
  comment?: string;
  slopes: string[];
  snow: { altitude: number; north: number; south: number }[];
}

const SLOPES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const SLOPE_FR: Record<string, string> = { SW: 'SO', W: 'O', NW: 'NO' };

/** « <2200 » → « Sous 2 200 m » ; « E » → « Est »… (LOC1 / LOC2 du bulletin). */
function locationLabel(loc: string): string {
  const alt = /([<>])\s*(\d+)/.exec(loc);
  if (alt) return `${alt[1] === '<' ? 'Sous' : 'Au-dessus de'} ${Number(alt[2]).toLocaleString('fr-FR')} m`;
  return ({ N: 'Nord', S: 'Sud', E: 'Est', O: 'Ouest', W: 'Ouest' } as Record<string, string>)[loc.trim()] ?? loc.trim();
}

export function parseBra(xml: string): BraBulletin | null {
  const head = attrs(xml, 'BULLETINS_NEIGE_AVALANCHE');
  const risque = attrs(xml, 'RISQUE');
  if (!head || !risque) return null;
  const levels: { label: string; risk: number }[] = [];
  const r1 = num(risque.RISQUE1);
  const r2 = num(risque.RISQUE2);
  if (r1 !== null && r2 !== null && risque.LOC1 && risque.LOC2) {
    levels.push({ label: locationLabel(risque.LOC1), risk: r1 }, { label: locationLabel(risque.LOC2), risk: r2 });
  }
  const pente = attrs(xml, 'PENTE') ?? {};
  // Hauteurs de neige du jour : le bloc ENNEIGEMENT avant l'historique des 7 derniers jours (BSH).
  const today = xml.split('<BSH')[0];
  const enneigement = /<ENNEIGEMENT\b[^>]*>([\s\S]*?)<\/ENNEIGEMENT>/.exec(today)?.[1] ?? '';
  const snow = [...enneigement.matchAll(/<NIVEAU\b([^>]*)\/?>/g)]
    .map((m) => {
      const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
      return { altitude: num(a.ALTI), north: num(a.N), south: num(a.S) };
    })
    .filter((n): n is { altitude: number; north: number; south: number } => n.altitude !== null && n.north !== null && n.south !== null);
  return {
    massif: head.MASSIF ?? '',
    issuedAt: parisTimeToIso(head.DATEBULLETIN),
    validUntil: parisTimeToIso(head.DATEVALIDITE ?? text(xml, 'DateValidite')),
    risk: num(risque.RISQUEMAXI) ?? r1,
    levels,
    comment: risque.COMMENTAIRE?.trim() || undefined,
    slopes: SLOPES.filter((s) => pente[s] === 'true').map((s) => SLOPE_FR[s] ?? s),
    snow,
  };
}

/** Bulletin du massif, ou null (pas de clé, service muet, hors saison des bulletins). */
export async function fetchBra(massifId: number): Promise<(BraBulletin & { servedAt: string }) | null> {
  const key = apiKey();
  if (!key) return null;
  // Publié vers 16 h, parfois corrigé : relu toutes les 30 minutes.
  const res = await fetchText(`${API}/DPBRA/v1/massif/BRA?id-massif=${massifId}&format=xml`, { revalidate: 1800, headers: { apikey: key, Accept: 'application/xml' } });
  const bulletin = res ? parseBra(res.text) : null;
  return bulletin && res ? { ...bulletin, servedAt: res.servedAt } : null;
}

// ---- Vigilance -------------------------------------------------------------------------------

/** Phénomènes de la vigilance Météo-France (identifiants de l'API). */
const PHENOMENA: Record<string, string> = {
  '1': 'Vent violent',
  '2': 'Pluie-inondation',
  '3': 'Orages',
  '4': 'Crues',
  '5': 'Neige-verglas',
  '6': 'Canicule',
  '7': 'Grand froid',
  '8': 'Avalanches',
  '9': 'Vagues-submersion',
};

interface VigilanceMap {
  product?: {
    update_time?: string;
    periods?: {
      echeance?: string;
      timelaps?: {
        domain_ids?: {
          domain_id?: string;
          max_color_id?: number;
          phenomenon_items?: { phenomenon_id?: string; phenomenon_max_color_id?: number }[];
        }[];
      };
    }[];
  };
}

export interface VigilanceResult {
  color: VigilanceColor;
  phenomena: { label: string; color: VigilanceColor }[];
  updatedAt?: string;
}

const asColor = (v: unknown): VigilanceColor | null => (v === 1 || v === 2 || v === 3 || v === 4 ? v : null);

/** Vigilance du jour et du lendemain pour un département : couleur la plus haute des deux. */
export function parseVigilance(data: VigilanceMap, department: string): VigilanceResult | null {
  const periods = data.product?.periods;
  if (!Array.isArray(periods)) return null;
  let color: VigilanceColor | null = null;
  const phenomena = new Map<string, VigilanceColor>();
  for (const period of periods) {
    const domain = period.timelaps?.domain_ids?.find((d) => d.domain_id === department);
    if (!domain) continue;
    const c = asColor(domain.max_color_id);
    if (c && (!color || c > color)) color = c;
    for (const p of domain.phenomenon_items ?? []) {
      const pc = asColor(p.phenomenon_max_color_id);
      const label = PHENOMENA[p.phenomenon_id ?? ''];
      if (pc && pc > 1 && label && pc > (phenomena.get(label) ?? 0)) phenomena.set(label, pc);
    }
  }
  if (!color) return null;
  return {
    color,
    phenomena: [...phenomena].map(([label, c]) => ({ label, color: c })).sort((a, b) => b.color - a.color),
    updatedAt: data.product?.update_time ? new Date(data.product.update_time).toISOString() : undefined,
  };
}

export async function fetchVigilance(department: string): Promise<(VigilanceResult & { servedAt: string }) | null> {
  const key = apiKey();
  if (!key) return null;
  const res = await fetchText(`${API}/DPVigilance/v1/cartevigilance/encours`, { revalidate: 600, headers: { apikey: key, Accept: 'application/json' } });
  const data = parseJson<VigilanceMap>(res);
  const vigilance = data ? parseVigilance(data, department) : null;
  return vigilance && res ? { ...vigilance, servedAt: res.servedAt } : null;
}
