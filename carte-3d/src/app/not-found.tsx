import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Carte introuvable — AltiStay' };

export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
      <p className="select-none font-display text-[7rem] leading-none text-primary/15">404</p>
      <h1 className="-mt-4 mb-4 font-display text-4xl text-foreground">Carte introuvable</h1>
      <p className="mb-8 text-foreground/60">Cette adresse ne correspond à aucune carte 3D.</p>
      <Link href="/" className="inline-flex rounded-2xl bg-primary px-6 py-3 font-bold text-primary-foreground hover:bg-primary/90">
        Voir les cartes disponibles
      </Link>
    </main>
  );
}
