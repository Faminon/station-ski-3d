// Ouvertures des pistes et remontées : carte interactive Lumiplan des stations
// (lumiplay.link/interactive-map/<nom>), celle que publient les sites officiels de
// Vars et Risoul. Elle lit deux fichiers publics, sans clé : la liste des pistes et
// remontées (« staticPoiData ») et leur état (« dynamicPoiData », rafraîchi par
// Lumiplan chaque minute).
//
// Ce service n'est pas documenté et n'est couvert par aucun contrat : avant la mise en
// production, demander l'accord de Lumiplan ou des stations. En cas de changement de
// format, `fetchLumiplan` renvoie null et la carte reste sans état en direct.

import { fetchJson } from '@/lib/apis/http';
import { fetchText, parseJson } from './http';

const API = 'https://public.lumiplay.link/interactive-map/v1/map';

export type LumiplanLevel = 'GREEN' | 'BLUE' | 'RED' | 'BLACK' | 'YELLOW' | 'UNDEF';

export interface LumiplanItem {
  id: string;
  name: string;
  kind: 'trail' | 'lift';
  /** Station (identifiant Lumiplan). */
  resortId: string;
  /** Pistes : niveau et type (DOWNHILL_SKIING, SNOWPARK, SKI_TOURING…). */
  level?: LumiplanLevel;
  trailType?: string;
  /** Remontées : CHAIRLIFT, DETACHABLE_CHAIRLIFT, GONDOLA, SURFACE_LIFT, MAGIC_CARPET… */
  liftType?: string;
  /** État Lumiplan (OPEN, CLOSED, OUT_OF_PERIOD_SEASON_BEGINNING, STOPPED_WIND…). */
  status?: string;
  grooming?: string;
  message?: string;
  hours?: string;
}

interface StaticData {
  items: { data: { id: number; name: string; type: string; trailType?: string; trailLevel?: string; liftType?: string } }[];
  resorts: { id: string; name: string; sectors: { id: string; name: string; itemIds: string[] }[] }[];
}

interface DynamicData {
  items: {
    id: number;
    openingStatus?: string;
    operating?: boolean;
    groomingStatus?: string;
    message?: { content?: string };
    openingTimesReal?: { beginTime?: string; endTime?: string }[];
  }[];
}

export interface LumiplanData {
  items: LumiplanItem[];
  /** Heure à laquelle Lumiplan a servi ces états (ISO). */
  fetchedAt: string;
}

/** Pistes et remontées de la carte Lumiplan `map`, avec leur état ; null si le service ne répond pas. */
export async function fetchLumiplan(map: string): Promise<LumiplanData | null> {
  // L'identifiant de la carte et la liste des pistes changent au plus une fois par saison.
  const meta = await fetchJson<{ id?: string }>(`${API}/name/${encodeURIComponent(map)}`, { revalidate: 86_400 });
  if (!meta?.id) return null;
  const [statics, dynamics] = await Promise.all([
    fetchJson<StaticData>(`${API}/${meta.id}/staticPoiData?lang=fr`, { revalidate: 3600 }),
    // Lumiplan le met à jour chaque minute.
    fetchText(`${API}/${meta.id}/dynamicPoiData?lang=fr`, { revalidate: 60 }),
  ]);
  const dynamic = parseJson<DynamicData>(dynamics);
  if (!statics?.items || !statics.resorts || !dynamic?.items || !dynamics) return null;

  const resortOf = new Map<string, string>();
  for (const resort of statics.resorts) for (const sector of resort.sectors ?? []) for (const id of sector.itemIds ?? []) resortOf.set(id, resort.id);
  const state = new Map(dynamic.items.map((d) => [String(d.id), d]));

  const items: LumiplanItem[] = [];
  for (const { data } of statics.items) {
    if (data.type !== 'TRAIL' && data.type !== 'LIFT') continue;
    const id = String(data.id);
    const live = state.get(id);
    const hours = live?.openingTimesReal?.[0];
    items.push({
      id,
      name: data.name.trim(),
      kind: data.type === 'LIFT' ? 'lift' : 'trail',
      resortId: resortOf.get(id) ?? '',
      level: data.trailLevel as LumiplanLevel | undefined,
      trailType: data.trailType,
      liftType: data.liftType,
      status: live?.openingStatus,
      grooming: live?.groomingStatus,
      message: live?.message?.content?.trim() || undefined,
      hours: hours?.beginTime && hours.endTime ? `${hours.beginTime}–${hours.endTime}` : undefined,
    });
  }
  return { items, fetchedAt: dynamics.servedAt };
}

const STOP_REASONS: Record<string, string> = {
  STOPPED_WIND: 'vent',
  STOPPED_WEATHER: 'météo',
  STOPPED_SECURING: 'sécurisation',
  STOPPED_TECHNICAL_ISSUE: 'incident technique',
};

/** État affiché d'après l'état Lumiplan (mêmes regroupements que la carte Lumiplan). */
export function lumiplanStatus(status: string | undefined): { status: 'open' | 'closed' | 'out'; label: string } | null {
  if (!status || status === 'UNDEF') return null;
  if (status.startsWith('OPEN')) return { status: 'open', label: status === 'OPEN_PEDESTRIAN_ONLY' ? 'Ouverte aux piétons' : 'Ouverte' };
  if (status.startsWith('OUT_OF_PERIOD')) return { status: 'out', label: 'Hors saison' };
  if (status.startsWith('STOPPED')) return { status: 'closed', label: STOP_REASONS[status] ? `En attente : ${STOP_REASONS[status]}` : 'En attente' };
  if (status === 'FORECAST' || status === 'DELAYED') return { status: 'closed', label: 'Ouverture prévue' };
  return { status: 'closed', label: 'Fermée' };
}

const GROOMING: Record<string, string> = {
  GROOMED: 'Damée',
  PARTIALLY_GROOMED: 'Partiellement damée',
  MORNING_GROOMED: 'Damée le matin',
  EVENING_GROOMED: 'Damée la veille au soir',
  H48_GROOMED: 'Damée il y a 48 h',
  GROOMING_FORECAST: 'Damage prévu',
  GROOMING: 'Damage en cours',
  NOT_GROOMED: 'Non damée',
};

export const groomingLabel = (grooming: string | undefined) => (grooming ? GROOMING[grooming] : undefined);
