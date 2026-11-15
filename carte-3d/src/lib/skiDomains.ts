// Cartes 3D des domaines skiables (pages /carte/[domaine], et /3-vallees) :
// une configuration par domaine — nom, textes, villages, fichiers de données,
// vue de départ. Le moteur de la carte est commun à tous les domaines.
//
// Toutes les données sont des fichiers de public/data. Les pistes, remontées, sommets
// et bâtiments des villages sont exportés depuis le site de recherche AltiStay
// (prisma/exportDomainMaps.ts) ; les lieux, forêts et routes sont générés ici par
// scripts/fetchDomainPois.ts, fetchDomainForests.ts et fetchDomainRoads.ts.

import type { PisteDifficulty } from './apis/overpass';


export interface DomainVillage {
  name: string;
  lat: number;
  lng: number;
  /** Altitude du village, en mètres. */
  altitude: number;
  /** Identifiant de la station AltiStay correspondante (fiche, séjours, vue 3D du village). */
  stationId?: string;
}

export interface DomainValley {
  id: string;
  name: string;
  /** Cap de la vue : on regarde vers le haut de la vallée (180 = vers le sud). */
  bearing: number;
  villages: DomainVillage[];
}

export interface SkiDomainConfig {
  /** Identifiant d'adresse : /carte/<slug>. */
  slug: string;
  /** Nom du domaine relié. */
  name: string;
  /** Sous-titre du panneau. */
  subtitle: string;
  /** Tracé du domaine : pistes, remontées, sommets (fichier de public/data, exporté du site de recherche). */
  pistesUrl: string;
  /** Stations du domaine et emprise de leurs villages (même export). */
  stationsUrl: string;
  /** Lieux et forêts (fichiers de public/data). */
  poisUrl: string;
  forestsUrl: string;
  /** Routes ouvertes aux voitures (scripts/fetchDomainRoads.ts). */
  roadsUrl?: string;
  /** Corrections d'après le plan officiel (noms, pistes absentes d'OpenStreetMap), voir src/lib/domainCorrections.ts. */
  correctionsUrl?: string;
  /**
   * Intégration sur le site d'une station (/embed/<slug>, dans une iframe). Absente : pas
   * d'intégration possible. `allowedOrigins` : sites autorisés à afficher la carte (ex.
   * « https://www.vars.com »), en plus d'AltiStay ; tout autre site reçoit un refus du navigateur.
   */
  embed?: { allowedOrigins: string[] };
  /** Point de départ de la vue avant le cadrage sur les pistes [lng, lat]. */
  center: [number, number];
  /** Cap de la vue d'ensemble (180 : on regarde vers le sud). */
  overviewBearing: number;
  /** Vallées et villages : repères sur la carte, liste du panneau, destinations d'itinéraire. */
  valleys: DomainValley[];
  /** Conditions en direct (src/lib/live, /api/live/<slug>). Absent : la carte n'en affiche pas. */
  live?: DomainLiveConfig;
}

/** Sources des conditions en direct d'un domaine. */
export interface DomainLiveConfig {
  /**
   * Carte interactive Lumiplan des stations (ouvertures des pistes et remontées) : nom de la
   * carte dans l'adresse lumiplay.link/interactive-map/<nom>. `resorts` : nom affiché par
   * identifiant de station Lumiplan, et code de remontée dans OpenStreetMap (« R5 », « V9 »).
   */
  lumiplan?: { map: string; resorts: { id: string; name: string; liftCode?: string }[] };
  /** Noms Lumiplan sans équivalent évident dans OpenStreetMap (fichier de public/data). */
  aliasesUrl?: string;
  /** Massif du bulletin avalanche de Météo-France (identifiant 1 à 74, nom affiché). */
  avalancheMassif: { id: number; name: string };
  /** Département de la vigilance : numéro Météo-France, nom, code NUTS 3 (MeteoAlarm). */
  department: { code: string; name: string; nuts3: string };
  /** Points des prévisions météo (bas et haut du domaine). */
  weatherPoints: { name: string; lat: number; lng: number; altitude: number }[];
}

const TROIS_VALLEES_VALLEYS: DomainValley[] = [
  {
    id: 'courchevel',
    name: 'Vallée de Courchevel',
    bearing: 180,
    villages: [
      { name: 'Courchevel 1850', lat: 45.4144, lng: 6.6347, altitude: 1850, stationId: 'courchevel' },
      { name: 'Courchevel Moriond', lat: 45.4179, lng: 6.6526, altitude: 1650 },
      { name: 'Courchevel Village', lat: 45.4222, lng: 6.6435, altitude: 1550 },
      { name: 'Courchevel Le Praz', lat: 45.4326, lng: 6.622, altitude: 1300 },
      { name: 'La Tania', lat: 45.4314, lng: 6.5965, altitude: 1400 },
    ],
  },
  {
    id: 'meribel',
    name: 'Vallée de Méribel',
    bearing: 180,
    villages: [
      { name: 'Méribel', lat: 45.3968, lng: 6.5656, altitude: 1450, stationId: 'meribel' },
      { name: 'Méribel-Mottaret', lat: 45.3735, lng: 6.581, altitude: 1750 },
      { name: 'Brides-les-Bains', lat: 45.4527, lng: 6.5672, altitude: 600 },
    ],
  },
  {
    id: 'belleville',
    name: 'Vallée des Belleville',
    bearing: 165,
    villages: [
      { name: 'Val Thorens', lat: 45.2978, lng: 6.5838, altitude: 2300, stationId: 'val-thorens' },
      { name: 'Les Menuires', lat: 45.3241, lng: 6.5383, altitude: 1850, stationId: 'les-menuires' },
      { name: 'Saint-Martin-de-Belleville', lat: 45.3806, lng: 6.505, altitude: 1450 },
    ],
  },
  {
    id: 'maurienne',
    name: 'Orelle — Maurienne',
    bearing: 0,
    villages: [{ name: 'Orelle', lat: 45.2099, lng: 6.5386, altitude: 900 }],
  },
];

const FORET_BLANCHE_VALLEYS: DomainValley[] = [
  {
    id: 'vars',
    name: 'Vars',
    // Le domaine de Vars s'étend à l'ouest et au sud des villages.
    bearing: 250,
    villages: [
      { name: 'Vars les Claux', lat: 44.5726, lng: 6.6816, altitude: 1850, stationId: 'vars' },
      { name: 'Vars Sainte-Marie', lat: 44.5938, lng: 6.6912, altitude: 1650 },
    ],
  },
  {
    id: 'risoul',
    name: 'Risoul',
    bearing: 200,
    villages: [{ name: 'Risoul 1850', lat: 44.6229, lng: 6.6358, altitude: 1850, stationId: 'risoul' }],
  },
];

export const SKI_DOMAINS: SkiDomainConfig[] = [
  {
    slug: '3-vallees',
    name: 'Les 3 Vallées',
    subtitle: 'Savoie · de Courchevel à Orelle, tout le domaine relié',
    pistesUrl: '/data/3-vallees-pistes.json',
    stationsUrl: '/data/3-vallees-stations.json',
    poisUrl: '/data/3-vallees-pois.json',
    forestsUrl: '/data/3-vallees-forests.json',
    roadsUrl: '/data/3-vallees-roads.json',
    embed: { allowedOrigins: [] },
    center: [6.58, 45.35],
    overviewBearing: 180,
    valleys: TROIS_VALLEES_VALLEYS,
  },
  {
    slug: 'foret-blanche',
    name: 'La Forêt Blanche',
    subtitle: 'Hautes-Alpes · Vars et Risoul, tout le domaine relié',
    pistesUrl: '/data/foret-blanche-pistes.json',
    stationsUrl: '/data/foret-blanche-stations.json',
    poisUrl: '/data/foret-blanche-pois.json',
    forestsUrl: '/data/foret-blanche-forests.json',
    roadsUrl: '/data/foret-blanche-roads.json',
    correctionsUrl: '/data/foret-blanche-corrections.json',
    embed: { allowedOrigins: [] },
    center: [6.66, 44.6],
    overviewBearing: 180,
    valleys: FORET_BLANCHE_VALLEYS,
    live: {
      // Carte interactive des sites officiels de Vars et Risoul (sans contrat : voir src/lib/live/lumiplan.ts).
      lumiplan: {
        map: 'espace-foret-blanche',
        resorts: [
          { id: '750', name: 'Vars', liftCode: 'V' },
          { id: '765', name: 'Risoul', liftCode: 'R' },
        ],
      },
      aliasesUrl: '/data/foret-blanche-live-aliases.json',
      avalancheMassif: { id: 20, name: 'Embrunais-Parpaillon' },
      department: { code: '05', name: 'Hautes-Alpes', nuts3: 'FR822' },
      weatherPoints: [
        { name: 'Vars les Claux', lat: 44.5726, lng: 6.6816, altitude: 1850 },
        { name: 'Risoul 1850', lat: 44.6229, lng: 6.6358, altitude: 1850 },
        { name: 'Pic de Chabrières', lat: 44.5721, lng: 6.643, altitude: 2746 },
      ],
    },
  },
];

export const skiDomain = (slug: string) => SKI_DOMAINS.find((d) => d.slug === slug) ?? null;

/** En-tête CSP de la carte intégrée : seuls AltiStay et les sites de la station peuvent l'afficher. */
export function embedFrameAncestors(slug: string): string {
  const origins = skiDomain(slug)?.embed?.allowedOrigins ?? [];
  return ["frame-ancestors 'self'", ...origins].join(' ');
}

export const DIFFICULTY_SINGULAR: Record<PisteDifficulty, string> = {
  green: 'Piste verte',
  blue: 'Piste bleue',
  red: 'Piste rouge',
  black: 'Piste noire',
  unknown: 'Piste non classée',
};

export const LIFT_LABELS: Record<string, string> = {
  chair_lift: 'Télésiège',
  gondola: 'Télécabine',
  cable_car: 'Téléphérique',
  mixed_lift: 'Télémix',
  funicular: 'Funiculaire',
  platter: 'Téléski',
  drag_lift: 'Téléski',
  't-bar': 'Téléski',
  'j-bar': 'Téléski',
  rope_tow: 'Fil neige',
  magic_carpet: 'Tapis roulant',
};
