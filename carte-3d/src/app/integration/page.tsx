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
  const example = domains.find((d) => d.slug === 'foret-blanche') ?? domains[0];
  const mobileUrl = example ? `${origin}/embed/${example.slug}` : null;

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

      {mobileUrl && <MobileAppSection url={mobileUrl} />}
    </main>
  );
}


/**
 * Carte dans l'appli mobile d'une station, dans une WebView : en ligne (/embed/<domaine>), ou
 * hors ligne avec le paquet téléchargeable (scripts/buildOfflinePack.ts, src/lib/offlinePack.ts).
 * Aucune clé : la carte est de toute façon publique sur AltiStay (/carte/…).
 */
function MobileAppSection({ url }: { url: string }) {
  const slug = url.split('/').pop()!;

  const swift = `import WebKit

let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
webView.uiDelegate = self
webView.navigationDelegate = self
webView.load(URLRequest(url: URL(string: "${url}")!))

// Liens externes (site d'un restaurant, Météo-France…) : ouverts dans Safari.
func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
             for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
  if let link = action.request.url { UIApplication.shared.open(link) }
  return nil
}

// iOS libère parfois la mémoire de la page en arrière-plan : on la recharge.
func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

// Info.plist : NSLocationWhenInUseUsageDescription = "Pour vous situer sur les pistes."`;

  const kotlin = `webView.settings.apply {
  javaScriptEnabled = true
  domStorageEnabled = true        // la carte retient la qualité adaptée au téléphone
  setGeolocationEnabled(true)
  setSupportMultipleWindows(true) // liens externes, voir onCreateWindow
}
webView.webChromeClient = object : WebChromeClient() {
  // À appeler une fois la permission ACCESS_FINE_LOCATION accordée à l'appli.
  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
    callback.invoke(origin, true, false)
  }
  // Liens externes : ouverts dans le navigateur du téléphone.
  override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
    val link = view.hitTestResult.extra ?: return false
    view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
    return false
  }
}
webView.loadUrl("${url}")

// AndroidManifest.xml : INTERNET et ACCESS_FINE_LOCATION.`;

  const reactNative = `import { Linking } from 'react-native';
import { WebView } from 'react-native-webview';

<WebView
  ref={webViewRef}
  source={{ uri: '${url}' }}
  geolocationEnabled
  domStorageEnabled
  setSupportMultipleWindows
  onOpenWindow={(e) => Linking.openURL(e.nativeEvent.targetUrl)}
  onContentProcessDidTerminate={() => webViewRef.current?.reload()}
  style={{ flex: 1 }}
/>`;

  const swiftOffline = `import Network

/// Sert le paquet décompressé sur http://127.0.0.1:8723. Port fixe : la carte y retrouve
/// d'une ouverture à l'autre ses réglages et les dernières conditions reçues.
final class CarteServer {
  private let root: URL
  private var listener: NWListener?
  init(root: URL) { self.root = root.standardizedFileURL }

  func start() throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 8723)
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
    listener.start(queue: .global(qos: .userInitiated))
    self.listener = listener
  }

  func stop() { listener?.cancel(); listener = nil }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: .global(qos: .userInitiated))
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
      let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
      var path = (target.split(separator: "?").first.map(String.init) ?? "/").removingPercentEncoding ?? "/"
      if path.hasSuffix("/") { path += "index.html" }
      let file = self.root.appendingPathComponent(path).standardizedFileURL
      let body = file.path.hasPrefix(self.root.path) ? try? Data(contentsOf: file) : nil
      let head = body.map { "HTTP/1.1 200 OK\\r\\nContent-Type: \\(Self.type(file.pathExtension))\\r\\nContent-Length: \\($0.count)\\r\\nConnection: close\\r\\n\\r\\n" }
        ?? "HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n"
      connection.send(content: Data(head.utf8) + (body ?? Data()), completion: .contentProcessed { _ in connection.cancel() })
    }
  }

  /// Types exacts : les modules JavaScript (.js, .mjs) sont refusés sous un autre type.
  static func type(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json": return "application/json"
    case "png": return "image/png"
    case "jpg": return "image/jpeg"
    case "woff2": return "font/woff2"
    case "pbf": return "application/x-protobuf"
    case "ico": return "image/x-icon"
    default: return "application/octet-stream"
    }
  }
}

// À l'ouverture de la carte (et au retour au premier plan : iOS coupe le serveur en arrière-plan) :
// try server.start(); webView.load(URLRequest(url: URL(string: "http://127.0.0.1:8723/embed/${slug}/")!))
// Info.plist : NSAppTransportSecurity → NSAllowsLocalNetworking = YES (adresse locale en http).`;

  const kotlinOffline = `// Paquet décompressé dans le stockage de l'appli, servi sous une adresse https réservée à
// cet usage par Android : la carte s'y comporte comme sur un vrai site.
val carte = File(context.filesDir, "carte")
val types = mapOf(
  "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript",
  "css" to "text/css", "json" to "application/json", "png" to "image/png",
  "jpg" to "image/jpeg", "woff2" to "font/woff2", "pbf" to "application/x-protobuf",
  "ico" to "image/x-icon",
)
webView.webViewClient = object : WebViewClient() {
  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
    val url = request.url
    if (url.host != "appassets.androidplatform.net") return null // conditions en direct : réseau
    var file = File(carte, url.path ?: "/").canonicalFile
    if (file.isDirectory) file = File(file, "index.html")
    if (!file.path.startsWith(carte.canonicalPath) || !file.isFile) {
      return WebResourceResponse("text/plain", null, 404, "Not Found", null, null)
    }
    return WebResourceResponse(types[file.extension] ?: "application/octet-stream", null, file.inputStream())
  }
}
webView.loadUrl("https://appassets.androidplatform.net/embed/${slug}/")`;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="mb-2 font-display text-2xl text-foreground">Dans l&apos;appli mobile de la station</h2>
        <p className="max-w-3xl leading-relaxed text-foreground/60">
          L&apos;appli affiche la carte dans une WebView, sur tout l&apos;écran : pas de clé ni de SDK à installer. Le
          relief, les sapins 3D, la recherche, les itinéraires et le guidage GPS sont les mêmes que sur le site, et la
          carte règle d&apos;elle-même sa qualité selon la puissance du téléphone. Deux façons de faire : en ligne (le plus
          simple), ou avec la carte téléchargée dans le téléphone, utilisable sans réseau sur les pistes.
        </p>
      </div>

      <h3 className="font-display text-xl text-foreground">1. En ligne</h3>
      <p className="max-w-3xl text-sm leading-relaxed text-foreground/60">
        Adresse à ouvrir : <code>{url}</code> (remplacez le nom du domaine au besoin).
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/60">
        <li>Localisation : l&apos;appli doit demander la permission au téléphone et l&apos;accorder à la WebView, sinon « Ma position » et le guidage restent inactifs.</li>
        <li>Liens externes : à ouvrir dans le navigateur du téléphone, pour ne pas quitter la carte.</li>
        <li>Stockage de la page (localStorage) activé : la carte y retient la qualité qui convient au téléphone et les dernières conditions reçues.</li>
        <li>Vue de départ : même réglage qu&apos;en iframe, après <code>#vue=</code> dans l&apos;adresse.</li>
      </ul>
      <div className="space-y-2">
        <h4 className="font-semibold text-foreground">iOS (Swift, WKWebView)</h4>
        <CopyCode code={swift} />
      </div>
      <div className="space-y-2">
        <h4 className="font-semibold text-foreground">Android (Kotlin, WebView)</h4>
        <CopyCode code={kotlin} />
      </div>
      <div className="space-y-2">
        <h4 className="font-semibold text-foreground">React Native (react-native-webview)</h4>
        <CopyCode code={reactNative} />
      </div>

      <h3 className="font-display text-xl text-foreground">2. Hors ligne : la carte téléchargée</h3>
      <p className="max-w-3xl text-sm leading-relaxed text-foreground/60">
        Nous fournissons un paquet par domaine : <code>{slug}.zip</code> (environ 80 Mo : la carte, ses données, les
        photos aériennes et le relief du domaine) et sa description <code>{slug}.json</code>, à l&apos;adresse que nous vous
        communiquons. Une fois le paquet dans le téléphone, la carte s&apos;ouvre et fonctionne sans réseau : relief,
        sapins, pistes, recherche, itinéraires et GPS. Seules les conditions en direct (remontées ouvertes, météo,
        avalanche) demandent du réseau ; sans lui, la carte montre les dernières reçues, avec leur heure. Hors de la zone
        du domaine, le fond est moins net sans réseau.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/60">
        <li>
          Bouton « Télécharger la carte » (de préférence en Wi-Fi) : télécharger <code>{slug}.zip</code>, vérifier son
          empreinte (<code>sha256</code> de <code>{slug}.json</code>), puis le décompresser dans le stockage de l&apos;appli,
          d&apos;abord dans un dossier temporaire, renommé une fois complet.
        </li>
        <li>
          Mises à jour : relire <code>{slug}.json</code> de temps en temps (quelques centaines d&apos;octets) ; si sa{' '}
          <code>version</code> a changé, retélécharger le paquet.
        </li>
        <li>
          Affichage : la WebView réglée comme ci-dessus (localisation, liens externes, stockage), mais la page vient du
          paquet, servie par l&apos;appli elle-même, comme ci-dessous. Une adresse de type <code>file://</code> ne convient
          pas : la carte a besoin d&apos;une vraie adresse web pour lire ses fichiers.
        </li>
        <li>
          Essai : ajoutez <code>?horsligne</code> à l&apos;adresse de la carte (<code>…/embed/{slug}/?horsligne</code>) :
          elle fait comme si le téléphone n&apos;avait pas de réseau.
        </li>
      </ol>
      <div className="space-y-2">
        <h4 className="font-semibold text-foreground">iOS : petit serveur local (Swift, sans dépendance)</h4>
        <CopyCode code={swiftOffline} />
      </div>
      <div className="space-y-2">
        <h4 className="font-semibold text-foreground">Android : fichiers servis par la WebView (Kotlin)</h4>
        <CopyCode code={kotlinOffline} />
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-foreground/60">
        React Native : même principe, avec un serveur local de fichiers (par exemple{' '}
        <code>@dr.pogodin/react-native-static-server</code>) qui sert le dossier décompressé, puis la WebView sur{' '}
        <code>http://127.0.0.1:&lt;port&gt;/embed/{slug}/</code>. Le serveur doit envoyer les types exacts listés dans
        l&apos;exemple iOS, et toujours sur le même port.
      </p>
    </section>
  );
}
