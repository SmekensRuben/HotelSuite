/** @type {import('tailwindcss').Config} */
const forest = {
  50: "#edf4ef",
  100: "#dce9e1",
  200: "#bdd2c4",
  300: "#91b49f",
  400: "#649078",
  500: "#42735b",
  600: "#2e5946",
  700: "#254b3c",
  800: "#1f4034",
  900: "#19392e",
  950: "#10281f",
};
const neutral = {
  50: "#faf8f4",
  100: "#f2efe8",
  200: "#e5e0d6",
  300: "#d2cbbf",
  400: "#a49b8d",
  500: "#71685d",
  600: "#60594f",
  700: "#49453d",
  800: "#343b32",
  900: "#222e26",
  950: "#15221b",
};
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: forest,
        gold: {
          50: "#f8f3e6",
          100: "#f1e5c9",
          300: "#cfb77e",
          500: "#9a7740",
          700: "#725629",
        },
        canvas: "#f5f2eb",
        gray: neutral,
        slate: neutral,
        // Compatibility aliases; new components use the brand palette.
        marriott: forest[800],
        "marriott-dark": forest[950],
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: Object.fromEntries(
          [1, 2, 3, 4, 5].map((number) => [
            number,
            `hsl(var(--chart-${number}))`,
          ]),
        ),
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "Iowan Old Style",
          "Palatino Linotype",
          "Book Antiqua",
          "Georgia",
          "serif",
        ],
      },
      boxShadow: {
        panel: "0 2px 12px rgb(31 64 52 / 4%)",
        lifted: "0 20px 60px rgb(31 64 52 / 10%)",
      },
      borderRadius: {
        DEFAULT: "0.5rem",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
