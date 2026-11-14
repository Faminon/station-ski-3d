import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tant que la carte vit dans un sous-dossier du dépôt du site de recherche : ce dossier
  // est bien la racine du projet (et non le dépôt parent, qui a son propre package-lock.json).
  turbopack: { root: __dirname },
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
