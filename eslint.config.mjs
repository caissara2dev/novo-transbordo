import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".agents/**",
      ".next/**",
      ".vercel/**",
      "coverage/**",
      "next-env.d.ts",
      "node_modules/**",
      "out/**",
      "tmp/**"
    ]
  },
  ...coreWebVitals,
  ...typescript,
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
];

export default config;
