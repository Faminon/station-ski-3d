import { redirect } from 'next/navigation';

// Adresse historique de la carte des 3 Vallées, conservée pour les liens déjà partagés.
export default function TroisVallees3DPage() {
  redirect('/carte/3-vallees');
}
