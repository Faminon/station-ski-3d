// Conditions en direct d'un domaine (réponse de /api/live/<domaine>) : ouvertures des
// pistes et remontées, bulletin avalanche, vigilance, prévisions. Types partagés par le
// serveur (src/lib/live/*) et la carte (src/components/domain/LivePanel.tsx).

/** État d'une piste ou d'une remontée, tel que la carte l'affiche. */
export type LiveStatus = 'open' | 'closed' | 'out';

export interface LiveItemState {
  status: LiveStatus;
  /** État précis, en français (« Ouverte », « En attente : vent », « Ouverture prévue »…). */
  label: string;
  /** Damage, en français (« Damée », « Damée du matin », « Non damée »…). */
  grooming?: string;
  /** Message de la station (« Fermé pour la saison »…). */
  message?: string;
  /** Horaires du jour, « 09:00–16:30 ». */
  hours?: string;
}

/** Source et fraîcheur d'un bloc de données. `ok: false` : la source n'a pas répondu, le bloc est vide. */
export interface LiveSource {
  ok: boolean;
  /** Nom affiché (« Lumiplan », « Météo-France »…). */
  name: string;
  /** Heure de la donnée (ISO), ou à défaut de sa récupération. */
  updatedAt: string | null;
  /** Raison d'absence, en français (« clé Météo-France absente »…). */
  note?: string;
}

export interface LiveOpenings {
  source: LiveSource;
  /** État par identifiant de tracé (identifiant OpenStreetMap, ou négatif pour une correction). */
  pistes: Record<string, LiveItemState>;
  lifts: Record<string, LiveItemState>;
  /** Comptes par station, d'après la source (toutes ses pistes de ski alpin, appariées ou non). */
  resorts: { name: string; pistesOpen: number; pistesTotal: number; liftsOpen: number; liftsTotal: number }[];
  /** Tout le domaine est hors saison (ou fermé) : la carte l'explique au lieu de tout griser sans un mot. */
  outOfSeason: boolean;
  /** Noms de la source sans tracé correspondant (à ajouter dans <domaine>-live-aliases.json). */
  unmatched: string[];
}

export interface AvalancheBulletin {
  source: LiveSource;
  massif: string;
  /** Risque maximal 1 à 5. */
  risk: number | null;
  /** Risque par tranche d'altitude quand il diffère (« < 2200 m » : 2, « > 2200 m » : 3). */
  levels: { label: string; risk: number }[];
  /** Commentaire du risque (« Au-dessus de 2200 m risque marqué… »). */
  comment?: string;
  /** Pentes les plus dangereuses : orientations (N, NE…). */
  slopes?: string[];
  /** Fin de validité du bulletin (ISO). */
  validUntil?: string;
  /** Hauteur de neige hors-piste par altitude, versants nord et sud (cm). */
  snow?: { altitude: number; north: number; south: number }[];
  /** Lien vers le bulletin complet. */
  url: string;
}

export type VigilanceColor = 1 | 2 | 3 | 4;

export interface Vigilance {
  source: LiveSource;
  /** Département (« Hautes-Alpes »). */
  area: string;
  /** Couleur maximale : 1 vert, 2 jaune, 3 orange, 4 rouge. */
  color: VigilanceColor | null;
  /** Phénomènes en vigilance jaune ou plus. */
  phenomena: { label: string; color: VigilanceColor }[];
  url: string;
}

export interface WeatherPoint {
  /** « Vars les Claux », « Sommets »… */
  name: string;
  altitude: number;
  temperature: number | null;
  feelsLike: number | null;
  windSpeed: number | null;
  windGusts: number | null;
  /** Direction d'où vient le vent, en degrés. */
  windDirection: number | null;
  /** Code temps WMO. */
  weatherCode: number | null;
  isDay: boolean;
  /** Neige estimée au sol (cm, modèle). */
  snowDepth: number | null;
  days: { date: string; min: number | null; max: number | null; snowfall: number | null; gusts: number | null; weatherCode: number | null }[];
}

export interface WeatherForecast {
  source: LiveSource;
  points: WeatherPoint[];
  /** Isotherme 0 °C (m), au premier point. */
  freezingLevel: number | null;
}

export interface LiveConditions {
  domain: string;
  generatedAt: string;
  /** Jour de pleine saison simulé (?demo=saison) : rien de cette réponse n'est réel. */
  demo?: true;
  openings: LiveOpenings;
  avalanche: AvalancheBulletin;
  vigilance: Vigilance;
  weather: WeatherForecast;
}
