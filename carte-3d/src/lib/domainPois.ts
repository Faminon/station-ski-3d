// Lieux d'un domaine skiable entier (carte 3D des 3 Vallées) : restaurants
// d'altitude, points de vue, snowparks, toilettes, secours… tirés
// d'OpenStreetMap (ODbL) par prisma/fetchDomainPois.ts et enregistrés dans
// public/data/. Les lieux « de village » reprennent le classement de la vue 3D
// d'une station (classifyPoi), complété ici par ceux qu'on trouve sur les pistes.

import { classifyPoi, type PoiCategoryId } from './village3d';

export type DomainPoiCategoryId =
  | 'restaurant'
  | 'bar'
  | 'hut'
  | 'viewpoint'
  | 'snowpark'
  | 'sled'
  | 'landmark'
  | 'picnic'
  | 'toilets'
  | 'rescue'
  | 'info'
  | 'ski'
  | 'leisure'
  | 'grocery'
  | 'shop'
  | 'lodging'
  | 'services'
  | 'transport';

export interface DomainPoiCategory {
  id: DomainPoiCategoryId;
  label: string;
  /** Couleur de la pastille sur la carte et dans le panneau. */
  color: string;
  emoji: string;
  /** Affichée dès l'ouverture de la carte ; les autres se cochent dans le panneau. */
  defaultOn: boolean;
}

/** Dans l'ordre du panneau : d'abord ce qui sert sur les pistes, puis la vie de village. */
export const DOMAIN_POI_CATEGORIES: DomainPoiCategory[] = [
  { id: 'restaurant', label: 'Restaurants', color: '#e8590c', emoji: '🍽️', defaultOn: true },
  { id: 'hut', label: 'Refuges', color: '#a0522d', emoji: '🛖', defaultOn: true },
  { id: 'viewpoint', label: 'Points de vue', color: '#7048e8', emoji: '🔭', defaultOn: true },
  { id: 'snowpark', label: 'Snowparks & zones ludiques', color: '#0c8599', emoji: '🏂', defaultOn: true },
  { id: 'sled', label: 'Pistes de luge', color: '#d6336c', emoji: '🛷', defaultOn: true },
  { id: 'landmark', label: 'Cols, lacs & sites', color: '#f08c00', emoji: '⭐', defaultOn: true },
  { id: 'picnic', label: 'Aires de pique-nique', color: '#5c940d', emoji: '🧺', defaultOn: true },
  { id: 'toilets', label: "Toilettes & points d'eau", color: '#1971c2', emoji: '🚻', defaultOn: true },
  { id: 'rescue', label: 'Secours & santé', color: '#e03131', emoji: '⛑️', defaultOn: true },
  { id: 'info', label: 'Offices de tourisme', color: '#495057', emoji: 'ℹ️', defaultOn: true },
  { id: 'bar', label: 'Bars & après-ski', color: '#c2255c', emoji: '🍻', defaultOn: false },
  { id: 'ski', label: 'Location & écoles de ski', color: '#1c7ed6', emoji: '🎿', defaultOn: false },
  { id: 'leisure', label: 'Loisirs & bien-être', color: '#0ca678', emoji: '🏊', defaultOn: false },
  { id: 'grocery', label: 'Alimentation', color: '#2f9e44', emoji: '🛒', defaultOn: false },
  { id: 'shop', label: 'Boutiques', color: '#9c36b5', emoji: '🛍️', defaultOn: false },
  { id: 'lodging', label: 'Hôtels & résidences', color: '#5c7cfa', emoji: '🏨', defaultOn: false },
  { id: 'services', label: 'Services', color: '#6c757d', emoji: '🏧', defaultOn: false },
  { id: 'transport', label: 'Transports & parkings', color: '#868e96', emoji: '🅿️', defaultOn: false },
];

export interface DomainPoi {
  id: string;
  name: string;
  category: DomainPoiCategoryId;
  /** Précision lisible (« Restaurant · savoyard », « Col »…). */
  kind: string;
  lng: number;
  lat: number;
  openingHours?: string;
  website?: string;
  phone?: string;
}

/** Emprise d'un snowpark ou d'une zone ludique : surface (contour fermé) ou tracé. */
export interface ParkZone {
  kind: 'snowpark' | 'playground';
  name?: string;
  /** Contour fermé (surface) ou ligne (tracé du parc), en [lng, lat]. */
  coordinates: number[][];
  closed: boolean;
}

export interface DomainPois {
  fetchedAt: string;
  pois: DomainPoi[];
  /** Emprises des parcs, quand OpenStreetMap les dessine (sinon, une zone est tracée autour du point). */
  zones?: ParkZone[];
}

type Tags = Record<string, string>;

/** Catégories de village (vue 3D d'une station) → catégories de la carte du domaine. */
const FROM_VILLAGE: Record<PoiCategoryId, DomainPoiCategoryId> = {
  food: 'restaurant',
  bar: 'bar',
  ski: 'ski',
  shop: 'shop',
  grocery: 'grocery',
  lodging: 'lodging',
  health: 'rescue',
  services: 'services',
  leisure: 'leisure',
  transport: 'transport',
};

const PISTE_KINDS: Record<string, { category: DomainPoiCategoryId; kind: string }> = {
  snow_park: { category: 'snowpark', kind: 'Snowpark' },
  playground: { category: 'snowpark', kind: 'Zone ludique' },
  ski_jump: { category: 'snowpark', kind: 'Tremplin' },
  sled: { category: 'sled', kind: 'Piste de luge' },
  ice_skate: { category: 'leisure', kind: 'Patinoire' },
};

const EMERGENCY_KINDS: Record<string, string> = {
  mountain_rescue: 'Secours en montagne',
  ski_patrol: 'Poste de secours des pistes',
  ambulance_station: 'Ambulances',
  defibrillator: 'Défibrillateur',
  phone: "Téléphone d'urgence",
};

/** Catégories dont un lieu sans nom reste utile : il est alors désigné par son type. */
export const NAMELESS_OK = new Set<DomainPoiCategoryId>(['viewpoint', 'snowpark', 'sled', 'picnic', 'toilets', 'rescue', 'services']);

/** Catégorie et libellé d'un objet OSM à l'échelle du domaine, ou null s'il n'intéresse pas le skieur. */
export function classifyDomainPoi(tags: Tags): { category: DomainPoiCategoryId; kind: string } | null {
  const piste = PISTE_KINDS[tags['piste:type'] ?? ''];
  if (piste) return piste;
  if (tags.tourism === 'viewpoint') return { category: 'viewpoint', kind: 'Point de vue' };
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') return { category: 'hut', kind: 'Refuge' };
  if (tags.tourism === 'picnic_site' || tags.leisure === 'picnic_table') return { category: 'picnic', kind: 'Aire de pique-nique' };
  if (tags.amenity === 'toilets') return { category: 'toilets', kind: 'Toilettes' };
  if (tags.amenity === 'drinking_water') return { category: 'toilets', kind: "Point d'eau potable" };
  if (tags.emergency && EMERGENCY_KINDS[tags.emergency]) return { category: 'rescue', kind: EMERGENCY_KINDS[tags.emergency] };
  if (tags.tourism === 'information') {
    return tags.information === 'office' ? { category: 'info', kind: 'Office de tourisme' } : null;
  }
  if (tags.natural === 'saddle' || tags.mountain_pass === 'yes') return { category: 'landmark', kind: 'Col' };
  if (tags.natural === 'water') return { category: 'landmark', kind: 'Lac' };
  if (tags.waterway === 'waterfall') return { category: 'landmark', kind: 'Cascade' };
  if (tags.natural === 'cave_entrance') return { category: 'landmark', kind: 'Grotte' };
  if (tags.tourism === 'museum') return { category: 'landmark', kind: 'Musée' };
  if (tags.tourism === 'attraction') return { category: 'landmark', kind: 'Site touristique' };

  const village = classifyPoi(tags);
  return village ? { category: FROM_VILLAGE[village.category], kind: village.kind } : null;
}
