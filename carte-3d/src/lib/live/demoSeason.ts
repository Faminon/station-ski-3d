// Simulation d'un jour de pleine saison (/carte/<domaine>?demo=saison) : sert à voir le rendu
// de la carte et du panneau quand le domaine est ouvert, hors saison ou pour une démonstration.
// La liste des pistes et remontées reste la vraie (Lumiplan) ; seuls leurs états, le bulletin
// avalanche, la vigilance et la météo sont inventés. La réponse porte `demo: true` et la carte
// l'affiche clairement : ces données ne doivent jamais passer pour réelles.

import type { SkiDomainConfig } from '@/lib/skiDomains';
import type { LumiplanItem } from './lumiplan';
import type { AvalancheBulletin, Vigilance, WeatherForecast } from './types';

/** Tirage stable de 0 à 1 d'après un identifiant (même résultat d'un appel à l'autre). */
function draw(id: string, salt = ''): number {
  let h = 2166136261;
  for (const c of salt + id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** États d'un beau jour de février : presque tout ouvert, quelques arrêts pour le vent en altitude. */
export function seasonItems(items: LumiplanItem[]): LumiplanItem[] {
  return items.map((item) => {
    const r = draw(item.id);
    if (item.kind === 'lift') {
      const carpet = /CARPET/.test(item.liftType ?? '');
      const status = carpet || r >= 0.1 ? 'OPEN' : r < 0.06 ? 'STOPPED_WIND' : 'CLOSED';
      return { ...item, status, grooming: undefined, message: status === 'CLOSED' ? 'Maintenance' : undefined, hours: '08:45–16:45' };
    }
    const status = r < 0.06 ? 'CLOSED' : r < 0.09 ? 'FORECAST' : 'OPEN';
    const g = draw(item.id, 'damage');
    const grooming = item.level === 'BLACK' && g < 0.5 ? 'NOT_GROOMED' : g < 0.25 ? 'MORNING_GROOMED' : 'GROOMED';
    return {
      ...item,
      status,
      grooming,
      message: status === 'CLOSED' ? 'Fermée pour sécurisation' : status === 'FORECAST' ? 'Ouverture prévue vers 11 h' : undefined,
      hours: '09:00–16:30',
    };
  });
}

/** Date du jour à Paris, décalée de `offset` jours (AAAA-MM-JJ). */
function parisDate(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
}

const source = (name: string) => ({ ok: true, name: `Simulation · ${name}`, updatedAt: new Date().toISOString() });

export function seasonAvalanche(domain: SkiDomainConfig): AvalancheBulletin {
  return {
    source: source('bulletin fictif'),
    massif: domain.live!.avalancheMassif.name,
    risk: 3,
    levels: [
      { label: '< 2200 m', risk: 2 },
      { label: '> 2200 m', risk: 3 },
    ],
    comment: 'Plaques à vent récentes au-dessus de 2200 m après les chutes de neige des deux derniers jours.',
    slopes: ['N', 'NE', 'E'],
    validUntil: `${parisDate(1)}T16:00:00+01:00`,
    snow: [
      { altitude: 1800, north: 110, south: 80 },
      { altitude: 2400, north: 190, south: 150 },
    ],
    url: 'https://meteofrance.com/meteo-montagne/alpes-du-sud/risques-avalanche',
  };
}

export function seasonVigilance(domain: SkiDomainConfig): Vigilance {
  const dep = domain.live!.department;
  return { source: source('vigilance fictive'), area: dep.name, color: 1, phenomena: [], url: 'https://vigilance.meteofrance.fr/' };
}

/** Grand beau après une chute de neige ; le vent forcit en altitude ; nouvelle perturbation dans deux jours. */
export function seasonWeather(domain: SkiDomainConfig): WeatherForecast {
  const points = domain.live!.weatherPoints.map((p) => {
    // Environ -6 °C à 1850 m, -12 °C vers 2750 m.
    const temperature = Math.round(6 - p.altitude * 0.0065);
    const high = p.altitude > 2300;
    return {
      name: p.name,
      altitude: p.altitude,
      temperature,
      feelsLike: temperature - (high ? 8 : 3),
      windSpeed: high ? 25 : 8,
      windGusts: high ? 45 : 15,
      windDirection: high ? 315 : 0,
      weatherCode: 0,
      isDay: true,
      snowDepth: Math.round(60 + p.altitude * 0.05),
      days: [
        { date: parisDate(0), min: temperature - 6, max: temperature + 2, snowfall: 0, gusts: high ? 45 : 20, weatherCode: 0 },
        { date: parisDate(1), min: temperature - 5, max: temperature + 3, snowfall: 0, gusts: high ? 50 : 25, weatherCode: 2 },
        { date: parisDate(2), min: temperature - 3, max: temperature + 1, snowfall: high ? 25 : 15, gusts: high ? 65 : 35, weatherCode: 73 },
      ],
    };
  });
  return { source: source('météo fictive'), points, freezingLevel: 1200 };
}
