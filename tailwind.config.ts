import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f2f8f7",
          100: "#deeeeb",
          200: "#bdddd7",
          300: "#9ccbc2",
          400: "#5caea0",
          500: "#2f8e80",
          600: "#217567",
          700: "#1d5e54",
          800: "#1b4b44",
          900: "#193f3a"
        }
      }
    }
  },
  plugins: []
};

export default config;
