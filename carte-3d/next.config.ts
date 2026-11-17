import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tant que la carte vit dans un sous-dossier du dépôt du site de recherche : ce dossier
  // est bien la racine du projet (et non le dépôt parent, qui a son propre package-lock.json).
  turbopack: { root: __dirname },
  // Développement ouvert depuis un tunnel Cloudflare (essai sur téléphone : `cloudflared tunnel
  // --url http://localhost:3001`) : sans cela, Next.js refuse la connexion du rechargement à chaud
  // (WebSocket /_next/webpack-hmr) venue d'une autre adresse que localhost. Sans effet en production.
  allowedDevOrigins: ['*.trycloudflare.com'],
  // Aucune page ne peut être affichée dans une iframe d'un autre site (protection contre
  // le « clickjacking »), sauf la carte à intégrer /embed/…, dont src/proxy.ts fixe les sites autorisés.
  async headers() {
    return [
      {
        source: '/((?!embed/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
