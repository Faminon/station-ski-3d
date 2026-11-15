// Icônes du panneau du domaine (lucide, cohérentes d'un système à l'autre). Les pastilles
// sur la carte gardent leurs emojis (dessinés dans une image MapLibre, voir poiIcon).
import {
  Banknote,
  Beer,
  BedDouble,
  Binoculars,
  CableCar,
  CircleParking,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Cross,
  House,
  Info,
  LayoutGrid,
  MapPin,
  Moon,
  Mountain,
  MountainSnow,
  ShoppingBag,
  ShoppingBasket,
  Snowflake,
  Star,
  Sun,
  Toilet,
  TreePine,
  Utensils,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import type { DomainPoiCategoryId } from '@/lib/domainPois';

export const POI_ICONS: Record<DomainPoiCategoryId, LucideIcon> = {
  restaurant: Utensils,
  hut: House,
  viewpoint: Binoculars,
  snowpark: Snowflake,
  sled: MountainSnow,
  landmark: Star,
  picnic: TreePine,
  toilets: Toilet,
  rescue: Cross,
  info: Info,
  bar: Beer,
  ski: MountainSnow,
  leisure: Waves,
  grocery: ShoppingBasket,
  shop: ShoppingBag,
  lodging: BedDouble,
  services: Banknote,
  transport: CircleParking,
};

/** Icônes des types de recherche et des résultats sans pastille de couleur. */
export const SEARCH_ICONS = {
  all: LayoutGrid,
  restaurant: Utensils,
  lift: CableCar,
  piste: Mountain,
  toilets: Toilet,
  hut: House,
  village: MapPin,
} as const;

/** Temps sensible (codes WMO d'Open-Meteo) : icône et libellé. */
export function weatherIcon(code: number | null, isDay = true): { Icon: LucideIcon; label: string } {
  if (code === null) return { Icon: Cloud, label: '' };
  if (code === 0) return isDay ? { Icon: Sun, label: 'Ensoleillé' } : { Icon: Moon, label: 'Ciel clair' };
  if (code <= 2) return { Icon: isDay ? CloudSun : Cloud, label: 'Peu nuageux' };
  if (code === 3) return { Icon: Cloud, label: 'Couvert' };
  if (code === 45 || code === 48) return { Icon: CloudFog, label: 'Brouillard' };
  if (code >= 51 && code <= 57) return { Icon: CloudDrizzle, label: 'Bruine' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { Icon: CloudRain, label: 'Pluie' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { Icon: CloudSnow, label: 'Neige' };
  if (code >= 95) return { Icon: CloudLightning, label: 'Orage' };
  return { Icon: Cloud, label: '' };
}
