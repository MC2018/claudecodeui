/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      screens: {
        // Phones in genuine landscape: short viewport, and wide enough that the
        // composer can actually fit a text field beside its toolbar.
        //
        // The `min-width` is essential, not cosmetic. When the on-screen
        // keyboard opens in PORTRAIT the visible viewport becomes roughly
        // 412x390 CSS px — wider than it is tall — so it satisfies both
        // `orientation: landscape` and `max-height`, and the single-row layout
        // fired while the user was typing in portrait. The toolbar then took
        // the full width and the textarea collapsed to about one character,
        // rendering typed text vertically. Real phone landscape is ~900px wide,
        // so the width gate separates the two cases cleanly.
        lscompact: { raw: '(orientation: landscape) and (max-height: 600px) and (min-width: 700px)' },
      },
      fontFamily: {
        sans: ['"Encode Sans"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        serif: ['Merriweather', 'Georgia', 'Cambria', '"Times New Roman"', 'serif'],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      spacing: {
        'safe-area-inset-bottom': 'env(safe-area-inset-bottom)',
        'mobile-nav': 'var(--mobile-nav-total)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'dialog-overlay-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'dialog-content-show': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'dialog-overlay-show': 'dialog-overlay-show 150ms ease-out',
        'dialog-content-show': 'dialog-content-show 150ms ease-out',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}