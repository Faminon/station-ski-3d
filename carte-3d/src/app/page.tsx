import Link from 'next/link';
import { ArrowRight, CalendarDays, Mountain, Snowflake } from 'lucide-react';
import { loadDomainData } from '@/lib/domainData';
import { SKI_DOMAINS } from '@/lib/skiDomains';

/**
 * Accueil : pour chaque domaine, la carte du jour (ouvertures et conditions réelles) ou la carte
 * d'un jour de pleine saison (simulation : pistes et remontées ouvertes, ?demo=saison).
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-winter-50 to-background px-4 py-16 sm:px-6">
      <div className="w-full max-w-4xl">
        <div className="mb-10 text-center">
          <span className="mb-3 inline-block text-sm font-bold uppercase tracking-[0.2em] text-accent">AltiStay</span>
          <h1 className="font-display text-4xl text-foreground sm:text-5xl">Choisissez votre carte</h1>
          <p className="mx-auto mt-3 max-w-md text-[15px] text-foreground/60">
            La carte d&apos;aujourd&apos;hui, avec les pistes réellement ouvertes, ou celle d&apos;un jour de pleine saison.
          </p>
        </div>

        <ul className="grid gap-5 sm:grid-cols-2">
          {SKI_DOMAINS.map((d) => {
            const stats = loadDomainData(d)?.stats;
            const villages = d.valleys.flatMap((v) => v.villages.filter((vil) => vil.stationId).map((vil) => vil.name));
            return (
              <li key={d.slug} className="flex flex-col overflow-hidden rounded-3xl border border-winter-100 bg-card shadow-sm">
                <div className="relative flex h-36 items-end bg-gradient-to-br from-winter-700 via-winter-500 to-ice-200 p-6">
                  <Mountain className="absolute right-6 top-6 h-10 w-10 text-white/70" strokeWidth={1.5} aria-hidden />
                  <h2 className="font-display text-3xl text-white drop-shadow">{d.name}</h2>
                </div>
                <div className="flex flex-1 flex-col gap-2 p-6">
                  <span className="text-sm text-foreground/60">{d.subtitle}</span>
                  {villages.length > 0 && <span className="text-sm text-foreground/80">{villages.join(' · ')}</span>}
                  {stats && (
                    <span className="text-xs font-semibold text-primary">
                      {stats.slopes} pistes · {stats.lifts} remontées
                    </span>
                  )}
                  <div className="mt-auto grid gap-2 pt-4">
                    <MapChoice
                      href={`/carte/${d.slug}`}
                      icon={CalendarDays}
                      title="Carte d’aujourd’hui"
                      sub="Pistes ouvertes et conditions en direct"
                      primary
                    />
                    <MapChoice
                      href={`/carte/${d.slug}?demo=saison`}
                      icon={Snowflake}
                      title="Pleine saison"
                      sub="Un jour type d’hiver, tout ouvert"
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}

function MapChoice({
  href,
  icon: Icon,
  title,
  sub,
  primary = false,
}: {
  href: string;
  icon: typeof Snowflake;
  title: string;
  sub: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
        primary ? 'bg-primary text-primary-foreground hover:bg-winter-700' : 'border border-winter-200 text-foreground hover:border-primary hover:bg-winter-50'
      }`}
    >
      <Icon className={`h-5 w-5 shrink-0 ${primary ? '' : 'text-primary'}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className={`block text-xs ${primary ? 'text-primary-foreground/75' : 'text-foreground/55'}`}>{sub}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 transition group-hover:translate-x-1" aria-hidden />
    </Link>
  );
}
