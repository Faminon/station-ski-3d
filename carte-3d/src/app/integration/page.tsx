import type { Metadata } from 'next';
import { headers } from 'next/headers';
import CopyCode from '@/components/domain/CopyCode';
import { SKI_DOMAINS } from '@/lib/skiDomains';

export const metadata: Metadata = {
  title: 'Intégrer la carte 3D — AltiStay',
  description: 'Code à coller sur le site de la station pour afficher la carte 3D du domaine.',
  robots: { index: false, follow: false },
};

/** Code d'intégration de la carte 3D de chaque domaine, à transmettre à la station. */
export default async function IntegrationPage() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3001';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const origin = `${proto}://${host}`;
  const domains = SKI_DOMAINS.filter((d) => d.embed);

  return (
    <main className="mx-auto max-w-5xl space-y-14 px-4 py-16 sm:px-6 lg:px-8">
      <header>
        <span className="mb-3 inline-block text-sm font-bold uppercase tracking-[0.2em] text-accent">Stations</span>
        <h1 className="mb-4 font-display text-4xl text-foreground">Intégrer la carte 3D sur votre site</h1>
        <p className="max-w-3xl leading-relaxed text-foreground/60">
          Collez ce code dans une page de votre site : la carte 3D du domaine s&apos;affiche avec la recherche, les
          itinéraires à ski et le guidage GPS. Elle ne s&apos;affiche que sur les adresses que vous nous avez communiquées
          (www.votre-station.com…) : copié ailleurs, le code ne montre rien.
        </p>
      </header>

      {domains.map((d) => {
        const url = `${origin}/embed/${d.slug}`;
        const code = `<iframe
  src="${url}"
  title="${d.name} — carte 3D des pistes"
  width="100%" height="640" style="border:0;border-radius:16px"
  allow="fullscreen; geolocation"
  loading="lazy"></iframe>`;
        const sites = d.embed!.allowedOrigins;
        return (
          <section key={d.slug} className="space-y-5">
            <div>
              <h2 className="mb-1 font-display text-2xl text-foreground">{d.name}</h2>
              <p className="text-sm text-foreground/55">
                Sites autorisés : {sites.length > 0 ? sites.join(', ') : 'aucun pour le moment (seulement AltiStay)'}.
              </p>
            </div>
            <CopyCode code={code} />
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/60">
              <li>
                <code>allow=&quot;geolocation&quot;</code> : nécessaire pour « Ma position » et le guidage GPS.{' '}
                <code>allow=&quot;fullscreen&quot;</code> : bouton plein écran.
              </li>
              <li>
                Vue de départ précise : ajoutez-la après <code>#</code>, par exemple{' '}
                <code>{`${url}#vue=13/${d.center[1]}/${d.center[0]}/${d.overviewBearing}/55`}</code> (zoom / latitude /
                longitude / cap / inclinaison). Le bouton « Partager » de la carte donne l&apos;adresse de la vue affichée, en
                /carte/… : remplacez /carte/ par /embed/.
              </li>
              <li>Hauteur conseillée : 600 px au moins ; sur téléphone, la carte s&apos;adapte à la largeur.</li>
            </ul>
            <div className="overflow-hidden rounded-2xl border border-winter-100">
              <iframe src={url} title={`${d.name} — aperçu`} className="block h-[520px] w-full" allow="fullscreen; geolocation" loading="lazy" />
            </div>
          </section>
        );
      })}
    </main>
  );
}
