// Prévisions météo : Open-Meteo (open-meteo.com), modèles de Météo-France (AROME,
// ARPEGE) et ECMWF, ramenés à l'altitude demandée. Sans clé pour un usage non
// commercial ; pour un usage commercial, Open-Meteo demande un abonnement :
// OPEN_METEO_API_KEY dans .env.local bascule sur leur API client. Données sous
// licence CC BY 4.0 : la source est citée sous le bloc météo.

import type { WeatherPoint } from './types';
import { fetchText, parisTimeToIso, parseJson } from './http';

interface OpenMeteoResponse {
  elevation?: number;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    wind_speed_10m?: number;
    wind_gusts_10m?: number;
    wind_direction_10m?: number;
    weather_code?: number;
    is_day?: number;
  };
  hourly?: { time?: string[]; snow_depth?: (number | null)[]; freezing_level_height?: (number | null)[] };
  daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    snowfall_sum?: (number | null)[];
    wind_gusts_10m_max?: (number | null)[];
  };
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface OpenMeteoResult {
  points: WeatherPoint[];
  freezingLevel: number | null;
  updatedAt?: string;
}

export async function fetchOpenMeteo(points: { name: string; lat: number; lng: number; altitude: number }[]): Promise<OpenMeteoResult | null> {
  if (!points.length) return null;
  const key = process.env.OPEN_METEO_API_KEY?.trim();
  const url = new URL(key ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast');
  const params: Record<string, string> = {
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    // Altitude du point : la température est corrigée d'après le relief réel, pas celui du modèle.
    elevation: points.map((p) => p.altitude).join(','),
    current: 'temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,is_day',
    hourly: 'snow_depth,freezing_level_height',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,snowfall_sum,wind_gusts_10m_max',
    forecast_days: '3',
    timezone: 'Europe/Paris',
    wind_speed_unit: 'kmh',
  };
  if (key) params.apikey = key;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Modèles relancés toutes les 1 à 3 heures : relu toutes les 30 minutes.
  const data = parseJson<OpenMeteoResponse | OpenMeteoResponse[]>(await fetchText(url.toString(), { revalidate: 1800 }));
  if (!data) return null;
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length || !list[0]?.current) return null;

  const hourIndex = (r: OpenMeteoResponse) => {
    const now = r.current?.time?.slice(0, 13);
    const i = r.hourly?.time?.findIndex((t) => t.slice(0, 13) === now) ?? -1;
    return Math.max(0, i);
  };

  const result: WeatherPoint[] = list.map((r, i) => {
    const c = r.current ?? {};
    const d = r.daily ?? {};
    const h = hourIndex(r);
    const depth = n(r.hourly?.snow_depth?.[h]);
    return {
      name: points[i].name,
      altitude: points[i].altitude,
      temperature: n(c.temperature_2m),
      feelsLike: n(c.apparent_temperature),
      windSpeed: n(c.wind_speed_10m),
      windGusts: n(c.wind_gusts_10m),
      windDirection: n(c.wind_direction_10m),
      weatherCode: n(c.weather_code),
      isDay: c.is_day !== 0,
      // Mètres → centimètres.
      snowDepth: depth === null ? null : Math.round(depth * 100),
      days: (d.time ?? []).map((date, j) => ({
        date,
        min: n(d.temperature_2m_min?.[j]),
        max: n(d.temperature_2m_max?.[j]),
        snowfall: n(d.snowfall_sum?.[j]),
        gusts: n(d.wind_gusts_10m_max?.[j]),
        weatherCode: n(d.weather_code?.[j]),
      })),
    };
  });
  return {
    points: result,
    freezingLevel: n(list[0].hourly?.freezing_level_height?.[hourIndex(list[0])]),
    updatedAt: parisTimeToIso(list[0].current?.time),
  };
}
