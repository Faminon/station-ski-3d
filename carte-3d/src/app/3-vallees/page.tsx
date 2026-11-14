import DomainMapPage, { domainMapMetadata } from '@/components/domain/DomainMapPage';

// Adresse historique de la carte des 3 Vallées, conservée pour les liens déjà partagés
// (même carte que /carte/3-vallees).
export const metadata = domainMapMetadata('3-vallees');

export default function TroisVallees3DPage() {
  return <DomainMapPage slug="3-vallees" />;
}
