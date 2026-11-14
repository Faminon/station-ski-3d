import Link from 'next/link';
import { ArrowRight, Mountain } from 'lucide-react';
import { loadDomainData } from '@/lib/domainData';
import { SKI_DOMAINS } from '@/lib/skiDomains';

/** Accueil : choix de la carte 3D (3 Vallées ou Forêt Blanche). */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-winter-50 to-background px-4 py-16 sm:px-6">
      <div className="w-full max-w-4xl">
        <div className="mb-10 text-center">
          <span className="mb-3 inline-block text-sm font-bold uppercase tracking-[0.2em] text-accent">AltiStay</span>
          <h1 className="font-display text-4xl text-foreground sm:text-5xl">Choisissez votre carte</h1>
        </div>

        <ul className="grid gap-5 sm:grid-cols-2">
          {SKI_DOMAINS.map((d) => {
            const stats = loadDomainData(d)?.stats;
            const villages = d.valleys.flatMap((v) => v.villages.filter((vil) => vil.stationId).map((vil) => vil.name));
            return (
              <li key={d.slug}>
                <Link
                  href={`/carte/${d.slug}`}
                  className="group flex h-full flex-col overflow-hidden rounded-3xl border border-winter-100 bg-card shadow-sm transition hover:-translate-y-1 hover:border-primary hover:shadow-lg"
                >
                  <div className="relative flex h-36 items-end bg-gradient-to-br from-winter-700 via-winter-500 to-ice-200 p-6">
                    <Mountain className="absolute right-6 top-6 h-10 w-10 text-white/70" strokeWidth={1.5} />
                    <span className="font-display text-3xl text-white drop-shadow">{d.name}</span>
                  </div>
                  <div className="flex flex-1 flex-col gap-3 p-6">
                    <span className="text-sm text-foreground/60">{d.subtitle}</span>
                    {villages.length > 0 && (
                      <span className="text-sm text-foreground/80">{villages.join(' · ')}</span>
                    )}
                    <span className="mt-auto flex items-center justify-between pt-2">
                      {stats ? (
                        <span className="text-xs font-semibold text-primary">
                          {stats.slopes} pistes · {stats.lifts} remontées
                        </span>
                      ) : (
                        <span />
                      )}
                      <span className="flex items-center gap-1 text-sm font-semibold text-accent">
                        Ouvrir la carte
                        <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                      </span>
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
