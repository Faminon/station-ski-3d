import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Copié depuis node_modules (scripts/copy-maplibre-worker.mjs).
    "public/vendor/**",
    // Paquets hors ligne fabriqués par scripts/buildOfflinePack.ts.
    "paquets/**",
  ]),
]);

export default eslintConfig;
