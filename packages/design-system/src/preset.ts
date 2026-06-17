import { definePreset } from '@pandacss/dev';

// One color per scheme. The OS preference applies first (media query), and an
// explicit [data-theme] pin set by the theme toggle overrides it.
const dual = (light: string, dark: string) => ({
  value: { base: light, _osDark: dark, _light: light, _dark: dark },
});

export const aiUsagePreset = definePreset({
  name: 'ai-usage',
  conditions: {
    extend: {
      light: '[data-theme=light] &',
      dark: '[data-theme=dark] &',
    },
  },
  globalCss: {
    html: {
      // Default to the OS scheme; the inline script in index.html pins a
      // stored choice before first paint, so there is no FOUC window.
      colorScheme: 'light dark',
      bg: 'canvas',
      accentColor: 'accent',
      // Keep scrolled-to elements clear of the sticky filter toolbar.
      scrollPaddingTop: '72px',
      '&[data-theme=light]': { colorScheme: 'light' },
      '&[data-theme=dark]': { colorScheme: 'dark' },
    },
    body: {
      bg: 'canvas',
      color: 'ink',
      fontFamily: 'sans',
      WebkitFontSmoothing: 'antialiased',
      textRendering: 'optimizeLegibility',
    },
    '::selection': {
      bg: 'accentSoft',
    },
  },
  theme: {
    extend: {
      keyframes: {
        drawerIn: {
          from: { transform: 'translateX(24px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        sheetIn: {
          from: { transform: 'translateY(24px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      tokens: {
        fonts: {
          sans: {
            value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          },
          mono: {
            value:
              'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace',
          },
        },
        radii: {
          sm: { value: '8px' },
          md: { value: '12px' },
          full: { value: '999px' },
        },
      },
      textStyles: {
        eyebrow: {
          value: {
            fontFamily: 'mono',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          },
        },
        label: {
          value: {
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
          },
        },
        numeric: {
          value: {
            fontFamily: 'mono',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.01em',
          },
        },
      },
      semanticTokens: {
        colors: {
          // Surfaces — warm paper in light, warm graphite in dark.
          canvas: dual('#F6F4EF', '#121110'),
          surface: dual('#FFFFFF', '#1A1917'),
          surfaceMuted: dual('#EFECE5', '#232120'),
          track: dual('#ECE8E0', '#2E2C28'),

          // Ink.
          ink: dual('#1F1D19', '#ECE9E2'),
          inkHover: dual('#3B3833', '#D6D2C8'),
          muted: dual('#6E6A60', '#969084'),
          faint: dual('#9C978B', '#6E6960'),

          // Hairlines and control borders.
          line: dual('#E5E2DA', '#2B2925'),
          lineStrong: dual('#D2CEC3', '#3A372F'),

          // Copper accent — the single brand color.
          accent: dual('#B14E12', '#E0833C'),
          accentSoft: dual('#F5E6D8', '#3A2410'),
          accentTint: dual('#F8F0E5', '#251B10'),
          focusRing: dual('rgba(177, 78, 18, 0.28)', 'rgba(224, 131, 60, 0.35)'),

          // Categorical series palette for charts (model migration, etc.).
          // c1 echoes the copper accent; the rest stay muted enough to sit on
          // paper/graphite surfaces in both schemes.
          chart: {
            c1: dual('#B14E12', '#E0833C'),
            c2: dual('#0E7569', '#46C3AC'),
            c3: dual('#6A47C8', '#AC92F2'),
            c4: dual('#2061B4', '#7FA9E8'),
            c5: dual('#647722', '#A9BB5E'),
            c6: dual('#0F6FA8', '#5FB5E2'),
          },

          // Harness badge pairs, recalibrated per scheme.
          harness: {
            claude: { fg: dual('#B05730', '#E5915F'), bg: dual('#F7E9E0', '#3B2415') },
            codex: { fg: dual('#0E7569', '#46C3AC'), bg: dual('#E0F0EB', '#11302A') },
            cursor: { fg: dual('#6A47C8', '#AC92F2'), bg: dual('#EDE8FB', '#271F40') },
            opencode: { fg: dual('#2061B4', '#7FA9E8'), bg: dual('#E3EDF9', '#15263C') },
            gemini: { fg: dual('#0F6FA8', '#5FB5E2'), bg: dual('#E1EFF8', '#102A3A') },
          },
        },
        shadows: {
          card: dual('0 1px 2px rgba(31, 29, 25, 0.05)', '0 1px 3px rgba(0, 0, 0, 0.5)'),
          overlay: dual('-12px 0 32px rgba(31, 29, 25, 0.14)', '-12px 0 32px rgba(0, 0, 0, 0.55)'),
        },
      },
    },
  },
});
