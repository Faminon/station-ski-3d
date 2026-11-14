// Adresse du site de recherche AltiStay (fiches station, séjours), pour les liens de
// la carte. Sans cette variable, la carte fonctionne seule et n'affiche pas ces liens.
export const SEARCH_SITE_URL = (process.env.NEXT_PUBLIC_SEARCH_SITE_URL ?? '').replace(/\/+$/, '');
