import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { loadDomainData } from '@/lib/domainData';
import { SKI_DOMAINS } from '@/lib/skiDomains';
import { SEARCH_SITE_URL } from '@/lib/searchSite';

/** Accueil : les cartes 3D disponibles. */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <span className="mb-3 inline-block text-sm font-bold uppercase tracking-[0.2em] text-accent">AltiStay</span>
      <h1 className="mb-4 font-display text-4xl text-foreground">Cartes 3D des domaines skiables</h1>
      <p className="mb-10 leading-relaxed text-foreground/60">Relief, pistes, remontées, lieux, itinéraires à ski et guidage GPS.</p>
      <ul className="space-y-4">
        {SKI_DOMAINS.map((d) => {
          const stats = loadDomainData(d)?.stats;
          return (
            <li key={d.slug}>
              <Link
                href={`/carte/${d.slug}`}
                className="flex items-center justify-between gap-4 rounded-3xl border border-winter-100 bg-card p-6 transition hover:border-primary"
              >
                <span>
                  <span className="block font-display text-2xl text-foreground">{d.name}</span>
                  <span className="mt-1 block text-sm text-foreground/55">{d.subtitle}</span>
                  {stats && (
                    <span className="mt-2 block text-xs font-semibold text-primary">
                      {stats.slopes} pistes · {stats.lifts} remontées
                    </span>
                  )}
                </span>
                <ArrowRight className="h-5 w-5 shrink-0 text-primary" />
              </Link>
            </li>
          );
        })}
      </ul>
      {SEARCH_SITE_URL && (
        <p className="mt-10 text-sm text-foreground/50">
          Comparer les séjours :{' '}
          <a href={SEARCH_SITE_URL} className="text-primary hover:underline">
            AltiStay
          </a>
        </p>
      )}
    </main>
  );
}
