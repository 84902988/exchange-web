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
    // Local Next.js build backups follow the repository's `.next.*/` ignore.
    ".next.*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Licensed third-party distribution; lint project wrappers instead.
    "public/tradingview/**",
  ]),
  {
    // Keep the current lint gate stable when a local install resolves a newer
    // react-hooks plugin than the lockfile; adopt compiler rules separately.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
