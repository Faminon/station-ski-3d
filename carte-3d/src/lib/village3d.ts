// Données de la vue 3D d'une station : bâtiments et lieux du village, tirés
// d'OpenStreetMap (ODbL) par prisma/fetchVillage3d.ts et stockés en base
// (colonne Station.village3d). Le relief vient des tuiles d'altitude ouvertes
// « Terrain Tiles » ; pistes et remontées réutilisent le plan des pistes.

export type PoiCategoryId =
  | 'food'
  | 'bar'
  | 'ski'
  | 'shop'
  | 'grocery'
  | 'lodging'
  | 'health'
  | 'services'
  | 'leisure'
  | 'transport';

export interface PoiCategory {
  id: PoiCategoryId;
  label: string;
  /** Couleur du point sur la carte et de l'étiquette dans la liste. */
  color: string;
  emoji: string;
}

export const POI_CATEGORIES: PoiCategory[] = [
  { id: 'food', label: 'Restaurants', color: '#e8590c', emoji: '🍽️' },
  { id: 'bar', label: 'Bars & après-ski', color: '#c2255c', emoji: '🍻' },
  { id: 'ski', label: 'Location & écoles de ski', color: '#1c7ed6', emoji: '🎿' },
  { id: 'grocery', label: 'Alimentation', color: '#2f9e44', emoji: '🛒' },
  { id: 'shop', label: 'Boutiques', color: '#7048e8', emoji: '🛍️' },
  { id: 'lodging', label: 'Hébergements', color: '#5c7cfa', emoji: '🏨' },
  { id: 'health', label: 'Santé', color: '#f03e3e', emoji: '⚕️' },
  { id: 'services', label: 'Services', color: '#495057', emoji: 'ℹ️' },
  { id: 'leisure', label: 'Loisirs & bien-être', color: '#0ca678', emoji: '🏊' },
  { id: 'transport', label: 'Transports & parkings', color: '#868e96', emoji: '🅿️' },
];

export const categoryOf = (id: PoiCategoryId) => POI_CATEGORIES.find((c) => c.id === id)!;

export interface VillagePoi {
  id: string;
  name: string;
  category: PoiCategoryId;
  /** Précision lisible (« Location de ski », « Pizzeria »…). */
  kind: string;
  lng: number;
  lat: number;
  openingHours?: string;
  website?: string;
  phone?: string;
}

export interface VillageBuilding {
  /** Hauteur estimée en mètres (voir estimateHeight). */
  h: number;
  /** Contour [lng, lat] fermé. */
  ring: [number, number][];
  name?: string;
}

/** Un des villages d'une station étagée (Courchevel 1850, Moriond…). */
export interface VillageSector {
  name: string;
  lng: number;
  lat: number;
  /** Rayon de la zone récupérée autour du centre, en mètres. */
  radius: number;
  /** Groupe affiché ensemble dans le choix du village (par défaut : le village seul). */
  group?: string;
}

/** Groupes de villages proposés par le bouton de choix, dans l'ordre. */
export function villageGroups(sectors: VillageSector[]): string[] {
  return [...new Set(sectors.map((z) => z.group ?? z.name))];
}

export interface Village3d {
  center: { lng: number; lat: number };
  fetchedAt: string;
  buildings: VillageBuilding[];
  pois: VillagePoi[];
  /** Villages de la station, quand elle en compte plusieurs (bouton de choix des groupes sur la vue 3D). */
  villages?: VillageSector[];
  /** Vue de départ sur l'ensemble des villages plutôt que sur le premier. */
  startOnAll?: boolean;
}

/**
 * Stations réparties en plusieurs villages : chacun est récupéré autour de son
 * propre centre, puis réunis dans une seule vue 3D. Les autres stations sont
 * récupérées en un seul cercle autour de leurs coordonnées (geocode.ts).
 */
export const STATION_VILLAGES: Record<string, { sectors: VillageSector[]; startOnAll?: boolean }> = {
  courchevel: {
    sectors: [
      { name: 'Courchevel 1850', lat: 45.4144, lng: 6.6347, radius: 750, group: 'Courchevel 1850, Moriond & Village' },
      { name: 'Courchevel Moriond (1650)', lat: 45.4179, lng: 6.6526, radius: 550, group: 'Courchevel 1850, Moriond & Village' },
      { name: 'Courchevel Village (1550)', lat: 45.4222, lng: 6.6435, radius: 450, group: 'Courchevel 1850, Moriond & Village' },
      { name: 'Courchevel Le Praz (1300)', lat: 45.4326, lng: 6.622, radius: 500, group: 'Le Praz & La Tania' },
      { name: 'La Tania', lat: 45.4314, lng: 6.5965, radius: 450, group: 'Le Praz & La Tania' },
    ],
  },
  // Le Lac et Val Claret, à 1,5 km l'un de l'autre, affichés ensemble (vue de départ).
  tignes: {
    sectors: [
      { name: 'Tignes le Lac', lat: 45.4692, lng: 6.9068, radius: 700, group: 'Tignes le Lac & Val Claret' },
      { name: 'Val Claret', lat: 45.4563, lng: 6.9, radius: 650, group: 'Tignes le Lac & Val Claret' },
      // Tignes 1800 avec le hameau voisin des Boisses.
      { name: 'Tignes 1800', lat: 45.4948, lng: 6.9255, radius: 500 },
      { name: 'Les Brévières', lat: 45.5077, lng: 6.9206, radius: 400 },
    ],
  },
  meribel: {
    sectors: [
      { name: 'Méribel', lat: 45.3968, lng: 6.5656, radius: 900 },
      { name: 'Méribel-Mottaret', lat: 45.3735, lng: 6.581, radius: 600 },
    ],
  },
  vars: {
    sectors: [
      { name: 'Vars les Claux', lat: 44.5726, lng: 6.6816, radius: 900, group: 'Vars les Claux & Sainte-Marie' },
      { name: 'Vars Sainte-Marie', lat: 44.5938, lng: 6.6912, radius: 550, group: 'Vars les Claux & Sainte-Marie' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Classement des objets OpenStreetMap

type Tags = Record<string, string>;

const FOOD = new Set(['restaurant', 'fast_food', 'cafe', 'ice_cream', 'food_court']);
const BAR = new Set(['bar', 'pub', 'nightclub', 'biergarten']);
const HEALTH = new Set(['pharmacy', 'doctors', 'clinic', 'hospital', 'dentist']);
const SERVICES = new Set(['bank', 'atm', 'post_office', 'police', 'townhall', 'toilets', 'place_of_worship', 'library', 'childcare', 'kindergarten', 'laundry']);
const TRANSPORT = new Set(['parking', 'bus_station', 'taxi', 'fuel', 'charging_station', 'car_rental']);
const LEISURE_AMENITY = new Set(['cinema', 'theatre', 'arts_centre', 'casino', 'spa']);
const GROCERY = new Set(['supermarket', 'convenience', 'bakery', 'butcher', 'cheese', 'deli', 'greengrocer', 'wine', 'alcohol', 'beverages', 'confectionery', 'pastry', 'seafood', 'farm']);
const SKI_SHOP = new Set(['ski', 'sports', 'outdoor']);
const LODGING = new Set(['hotel', 'apartment', 'chalet', 'guest_house', 'hostel', 'motel', 'alpine_hut']);
const LEISURE = new Set(['sports_centre', 'swimming_pool', 'ice_rink', 'fitness_centre', 'spa', 'water_park', 'bowling_alley', 'playground', 'pitch']);

const KIND_LABELS: Record<string, string> = {
  restaurant: 'Restaurant', fast_food: 'Restauration rapide', cafe: 'Café', ice_cream: 'Glacier',
  bar: 'Bar', pub: 'Pub', nightclub: 'Discothèque', pharmacy: 'Pharmacie', doctors: 'Médecin',
  clinic: 'Centre médical', hospital: 'Hôpital', dentist: 'Dentiste', bank: 'Banque', atm: 'Distributeur',
  post_office: 'Poste', police: 'Police', townhall: 'Mairie', toilets: 'Toilettes', place_of_worship: 'Lieu de culte',
  library: 'Bibliothèque', childcare: 'Garderie', kindergarten: 'Garderie', laundry: 'Laverie',
  parking: 'Parking', bus_station: 'Gare routière', taxi: 'Taxis', fuel: 'Station-service',
  charging_station: 'Recharge électrique', car_rental: 'Location de voitures', cinema: 'Cinéma',
  theatre: 'Théâtre', casino: 'Casino', spa: 'Spa', supermarket: 'Supermarché', convenience: 'Épicerie',
  bakery: 'Boulangerie', butcher: 'Boucherie', cheese: 'Fromagerie', deli: 'Traiteur', wine: 'Cave à vins',
  alcohol: 'Cave', ski: 'Location / magasin de ski', sports: 'Magasin de sport', outdoor: 'Équipement montagne',
  hotel: 'Hôtel', apartment: 'Résidence / appartements', chalet: 'Chalet', guest_house: "Chambres d'hôtes",
  hostel: 'Auberge', sports_centre: 'Centre sportif', swimming_pool: 'Piscine', ice_rink: 'Patinoire',
  fitness_centre: 'Salle de sport', water_park: 'Centre aquatique', bowling_alley: 'Bowling',
  information: "Office de tourisme / information", ski_school: 'École de ski', clothes: 'Vêtements',
  gift: 'Souvenirs', jewelry: 'Bijouterie', optician: 'Opticien', hairdresser: 'Coiffeur', beauty: 'Institut de beauté',
  tobacco: 'Tabac-presse', newsagent: 'Presse', books: 'Librairie', toys: 'Jouets', shoes: 'Chaussures',
};

/** Catégorie et libellé d'un objet OSM, ou null s'il n'intéresse pas le visiteur. */
export function classifyPoi(tags: Tags): { category: PoiCategoryId; kind: string } | null {
  const { amenity, shop, tourism, leisure, office } = tags;
  const label = (key: string | undefined, fallback: string) => (key && KIND_LABELS[key]) || fallback;

  if (amenity === 'ski_school' || office === 'ski_school' || /\b(esf|école du ski|ecole du ski|ski school)\b/i.test(tags.name ?? '')) {
    return { category: 'ski', kind: 'École de ski' };
  }
  if (shop && SKI_SHOP.has(shop)) return { category: 'ski', kind: label(shop, 'Magasin de ski') };
  if (tags['rental'] && /ski/.test(tags['rental'])) return { category: 'ski', kind: 'Location de ski' };
  if (amenity && FOOD.has(amenity)) return { category: 'food', kind: label(amenity, 'Restaurant') };
  if (amenity && BAR.has(amenity)) return { category: 'bar', kind: label(amenity, 'Bar') };
  if (amenity && HEALTH.has(amenity)) return { category: 'health', kind: label(amenity, 'Santé') };
  if (shop && GROCERY.has(shop)) return { category: 'grocery', kind: label(shop, 'Alimentation') };
  if (shop) return { category: 'shop', kind: label(shop, 'Boutique') };
  if (tourism && LODGING.has(tourism)) return { category: 'lodging', kind: label(tourism, 'Hébergement') };
  if (tourism === 'information' && tags.information === 'office') return { category: 'services', kind: label('information', 'Information') };
  if ((leisure && LEISURE.has(leisure)) || (amenity && LEISURE_AMENITY.has(amenity))) {
    return { category: 'leisure', kind: label(leisure ?? amenity, 'Loisirs') };
  }
  if (amenity && SERVICES.has(amenity)) return { category: 'services', kind: label(amenity, 'Service') };
  if (amenity && TRANSPORT.has(amenity)) return { category: 'transport', kind: label(amenity, 'Transport') };
  return null;
}

/**
 * Hauteur d'un bâtiment : tag `height`, sinon `building:levels` (3 m par niveau,
 * plus le toit), sinon une valeur par type. En station, la plupart des
 * immeubles n'ont pas de hauteur renseignée dans OpenStreetMap : ces valeurs
 * par défaut sont des estimations.
 */
export function estimateHeight(tags: Tags): number {
  const h = parseFloat((tags.height ?? '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0 && h < 200) return h;
  const levels = parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0 && levels < 60) return levels * 3 + 2;
  switch (tags.building) {
    case 'apartments':
    case 'residential':
    case 'hotel':
      return 18;
    case 'commercial':
    case 'retail':
    case 'civic':
    case 'public':
      return 10;
    case 'chalet':
    case 'house':
    case 'detached':
      return 9;
    case 'garage':
    case 'garages':
    case 'shed':
    case 'hut':
    case 'cabin':
    case 'roof':
      return 4;
    default:
      return 12;
  }
}
