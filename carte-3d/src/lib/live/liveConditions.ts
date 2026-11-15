// Conditions en direct d'un domaine, assemblées côté serveur (route /api/live/<domaine>) :
// chaque source est appelée séparément, avec son propre cache (voir chaque fichier) ; une
// source muette laisse son bloc vide avec `source.ok = false`, sans empêcher les autres.

import type { StationPisteMap } from '@/lib/apis/overpass';
import { applyCorrections, type DomainCorrections } from '@/lib/domainCorrections';
import type { SkiDomainConfig } from '@/lib/skiDomains';
import { fetchLumiplan, lumiplanStatus } from './lumiplan';
import { matchLumiplan, prepareTracks, type LiveAliases, type PreparedTracks } from './matchLumiplan';
import { fetchBra, fetchVigilance, hasMeteoFranceKey } from './meteoFrance';
import { fetchMeteoAlarm } from './meteoAlarm';
import { fetchOpenMeteo } from './openMeteo';
import { seasonAvalanche, seasonItems, seasonVigilance, seasonWeather } from './demoSeason';
import type { AvalancheBulletin, LiveConditions, LiveOpenings, Vigilance, WeatherForecast } from './types';

/**
 * Fichier de public/data, lu sur le site lui-même (`origin`) : fonctionne quel que soit le dossier
 * de lancement du serveur, et sur un hébergement où public/ n'est servi que par le CDN.
 */
async function readData<T>(origin: string, url: string | undefined): Promise<T | null> {
  if (!url) return null;
  try {
    const res = await fetch(new URL(url, origin), { cache: 'force-cache', signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

type DomainTracks = { tracks: PreparedTracks; aliases: LiveAliases | null };
/** Tracés du domaine (corrections comprises), préparés une fois par processus : ils ne changent qu'au déploiement. */
const tracksCache = new Map<string, Promise<DomainTracks | null>>();
function domainTracks(domain: SkiDomainConfig, origin: string): Promise<DomainTracks | null> {
  let pending = tracksCache.get(domain.slug);
  if (!pending) {
    pending = (async () => {
      const [map, corrections, aliases] = await Promise.all([
        readData<StationPisteMap>(origin, domain.pistesUrl),
        readData<DomainCorrections>(origin, domain.correctionsUrl),
        readData<LiveAliases>(origin, domain.live?.aliasesUrl),
      ]);
      if (!map) return null;
      return { tracks: prepareTracks(applyCorrections(map, corrections), domain.live?.lumiplan?.resorts ?? []), aliases };
    })();
    tracksCache.set(domain.slug, pending);
    // Échec (serveur qui démarre…) : pas gardé, nouvel essai au prochain appel.
    void pending.then((t) => {
      if (!t) tracksCache.delete(domain.slug);
    });
  }
  return pending;
}

async function openings(domain: SkiDomainConfig, origin: string, demo = false): Promise<LiveOpenings> {
  const config = domain.live?.lumiplan;
  const empty = (note: string): LiveOpenings => ({
    source: { ok: false, name: 'Lumiplan', updatedAt: null, note },
    pistes: {},
    lifts: {},
    resorts: [],
    outOfSeason: false,
    unmatched: [],
  });
  if (!config) return empty('Pas de source des ouvertures pour ce domaine');
  const [real, prepared] = await Promise.all([fetchLumiplan(config.map), domainTracks(domain, origin)]);
  if (!real) return empty('Le service des ouvertures ne répond pas');
  // Simulation : vraie liste des pistes et remontées, états inventés (voir demoSeason.ts).
  const data = demo ? { items: seasonItems(real.items), fetchedAt: new Date().toISOString() } : real;
  if (!prepared) return empty('Tracé du domaine introuvable');

  const resortName = (id: string) => config.resorts.find((r) => r.id === id)?.name ?? id;
  const matched = matchLumiplan(data.items, prepared.tracks, prepared.aliases, resortName);

  // Comptes par station, d'après Lumiplan : pistes de ski alpin et remontées.
  const resorts = config.resorts.map((r) => {
    const mine = data.items.filter((i) => i.resortId === r.id);
    const trails = mine.filter((i) => i.kind === 'trail' && i.trailType === 'DOWNHILL_SKIING');
    const lifts = mine.filter((i) => i.kind === 'lift');
    const open = (list: typeof mine) => list.filter((i) => lumiplanStatus(i.status)?.status === 'open').length;
    return { name: r.name, pistesOpen: open(trails), pistesTotal: trails.length, liftsOpen: open(lifts), liftsTotal: lifts.length };
  });
  const liftStates = data.items.filter((i) => i.kind === 'lift').map((i) => lumiplanStatus(i.status)?.status);
  const outOfSeason = !liftStates.includes('open') && liftStates.filter((s) => s === 'out').length >= liftStates.length / 2;

  return {
    source: { ok: true, name: demo ? 'Simulation · états fictifs sur la liste Lumiplan' : 'Lumiplan (stations)', updatedAt: data.fetchedAt },
    pistes: matched.pistes,
    lifts: matched.lifts,
    resorts,
    outOfSeason,
    unmatched: matched.unmatched,
  };
}

async function avalanche(domain: SkiDomainConfig): Promise<AvalancheBulletin> {
  const massif = domain.live!.avalancheMassif;
  const url = 'https://meteofrance.com/meteo-montagne/alpes-du-sud/risques-avalanche';
  const bra = await fetchBra(massif.id);
  if (!bra) {
    return {
      source: {
        ok: false,
        name: 'Météo-France',
        updatedAt: null,
        note: hasMeteoFranceKey() ? 'Bulletin indisponible (service muet, ou pas de bulletin hors saison)' : 'Clé Météo-France non configurée',
      },
      massif: massif.name,
      risk: null,
      levels: [],
      url,
    };
  }
  return {
    source: { ok: true, name: 'Météo-France', updatedAt: bra.issuedAt ?? bra.servedAt },
    massif: massif.name,
    risk: bra.risk,
    levels: bra.levels,
    comment: bra.comment,
    slopes: bra.slopes,
    validUntil: bra.validUntil,
    snow: bra.snow,
    url,
  };
}

async function vigilance(domain: SkiDomainConfig): Promise<Vigilance> {
  const dep = domain.live!.department;
  const url = `https://vigilance.meteofrance.fr/fr/${dep.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '-')}`;
  const mf = await fetchVigilance(dep.code);
  if (mf) return { source: { ok: true, name: 'Météo-France', updatedAt: mf.updatedAt ?? mf.servedAt }, area: dep.name, color: mf.color, phenomena: mf.phenomena, url };
  // Repli sans clé : les vigilances de Météo-France relayées par MeteoAlarm.
  const alarm = await fetchMeteoAlarm(dep.nuts3, dep.name);
  if (alarm) {
    return {
      source: { ok: true, name: 'MeteoAlarm (Météo-France)', updatedAt: alarm.updatedAt ?? alarm.servedAt },
      area: dep.name,
      color: alarm.color,
      phenomena: alarm.phenomena,
      url,
    };
  }
  return { source: { ok: false, name: 'Météo-France', updatedAt: null, note: 'Vigilance indisponible' }, area: dep.name, color: null, phenomena: [], url };
}

async function weather(domain: SkiDomainConfig): Promise<WeatherForecast> {
  const forecast = await fetchOpenMeteo(domain.live!.weatherPoints);
  if (!forecast) return { source: { ok: false, name: 'Open-Meteo', updatedAt: null, note: 'Prévisions indisponibles' }, points: [], freezingLevel: null };
  return { source: { ok: true, name: 'Open-Meteo', updatedAt: forecast.updatedAt ?? null }, points: forecast.points, freezingLevel: forecast.freezingLevel };
}

/**
 * Conditions en direct, ou null si le domaine n'en a pas. `origin` : adresse du site (fichiers de public/data).
 * `demo` : jour de pleine saison simulé (demoSeason.ts), marqué comme tel dans la réponse.
 */
export async function loadLiveConditions(domain: SkiDomainConfig, origin: string, demo = false): Promise<LiveConditions | null> {
  if (!domain.live) return null;
  const [o, a, v, w] = demo
    ? [await openings(domain, origin, true), seasonAvalanche(domain), seasonVigilance(domain), seasonWeather(domain)]
    : await Promise.all([openings(domain, origin), avalanche(domain), vigilance(domain), weather(domain)]);
  return {
    domain: domain.slug,
    generatedAt: new Date().toISOString(),
    ...(demo ? { demo: true as const } : {}),
    openings: o,
    avalanche: a,
    vigilance: v,
    weather: w,
  };
}
