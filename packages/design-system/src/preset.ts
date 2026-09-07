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
      scrollPaddingTop: { base: '72px', md: '180px', lg: '132px' },
      // The centred max-width shell otherwise re-centres whenever a sub-tab crosses the viewport height.
      scrollbarGutter: 'stable',
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
          sm: { value: '6px' },
          md: { value: '10px' },
          full: { value: '999px' },
        },
      },
      textStyles: {
        eyebrow: {
          value: {
            fontFamily: 'sans',
            fontSize: '10px',
            fontWeight: 550,
            letterSpacing: '0.14em',
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
          // Atelier surfaces: soft mineral paper and cool graphite.
          // The accent belongs to navigation and interaction, not status or chart identity.
          canvas: dual('#F6F5F8', '#111116'),
          surface: dual('#FFFFFF', '#17171E'),
          surfaceMuted: dual('#EEECF2', '#23222D'),
          controlDefault: dual('#EEECF2', '#23222D'),
          track: dual('#E5E1ED', '#302E3C'),

          // Ink.
          ink: dual('#27232F', '#EAE8F1'),
          inkHover: dual('#41384D', '#D6CCE5'),
          muted: dual('#676170', '#A6A2B4'),
          faint: dual('#6A6273', '#A19DAF'),

          // Hairlines and control borders.
          line: dual('#DED9E5', '#302D3B'),
          lineStrong: dual('#8A8195', '#7E768C'),

          // Lavender is the Atelier interaction accent. Tinted surfaces stay quiet
          // enough for dense tables and long-form session and Skill detail.
          accent: dual('#735095', '#C5ADEE'),
          accentSoft: dual('#EDE3F7', '#332A43'),
          accentTint: dual('#F2ECF8', '#25202F'),
          focusRing: dual('rgba(115, 80, 149, 0.28)', 'rgba(197, 173, 238, 0.35)'),

          // Translucent lavender is reserved for active interaction feedback. It
          // stays separate from categorical and status roles in both schemes.
          interaction: {
            brush: dual('rgba(115, 80, 149, 0.13)', 'rgba(197, 173, 238, 0.16)'),
            brushHover: dual('rgba(115, 80, 149, 0.06)', 'rgba(197, 173, 238, 0.09)'),
          },

          // Categorical series palette for charts (model migration, etc.).
          // Series colors remain distinct from the interaction-only accent.
          chart: {
            c1: dual('#9B4210', '#F19A57'),
            c2: dual('#0E7569', '#46C3AC'),
            c3: dual('#6A47C8', '#AC92F2'),
            c4: dual('#2061B4', '#7FA9E8'),
            c5: dual('#647722', '#A9BB5E'),
            c6: dual('#0F6FA8', '#5FB5E2'),
            // c7-c13 extend the ranked series palette. c4 is excluded from
            // that order because c4 and c6 sit too close in OKLab.
            c7: dual('#588BE0', '#5590F3'),
            c8: dual('#3B4FA5', '#A7B5FE'),
            c9: dual('#9B7300', '#C69612'),
            c10: dual('#9250A0', '#DF99EF'),
            c11: dual('#853376', '#D37BC1'),
            c12: dual('#0A6B1D', '#61B565'),
            c13: dual('#B8527E', '#FC90BC'),
          },

          // Provider identity marks, taken from each vendor's own published favicon. These are not
          // series colors: `harness.*` below stays the validated categorical palette charts use to
          // separate N series, while these identify one provider on its own badge. Cursor and
          // OpenCode publish monochrome marks, so they have no entry and fall back to `harness.*`.
          // Both are contrast-checked against the light and dark chart surfaces.
          brand: {
            claude: dual('#C4603F', '#D97757'),
            codex: dual('#0068C9', '#3D9DFA'),
          },

          // Harness badge pairs, recalibrated per scheme.
          harness: {
            claude: { fg: dual('#8C3E74', '#D98ABC'), bg: dual('#F5E5EF', '#351E2F') },
            codex: { fg: dual('#0E7569', '#46C3AC'), bg: dual('#E0F0EB', '#11302A') },
            cursor: { fg: dual('#6A47C8', '#AC92F2'), bg: dual('#EDE8FB', '#271F40') },
            opencode: { fg: dual('#2061B4', '#7FA9E8'), bg: dual('#E3EDF9', '#15263C') },
            gemini: { fg: dual('#0F6FA8', '#5FB5E2'), bg: dual('#E1EFF8', '#102A3A') },
          },

          status: {
            ok: dual('#2C7858', '#5BA97E'),
            okSoft: dual('#E4F0EA', '#14302A'),
            warn: dual('#8F620E', '#D9AC5A'),
            warnSoft: dual('#F6ECD5', '#35290F'),
            danger: dual('#B3261E', '#E08A80'),
            dangerSoft: dual('#F6E1DD', '#3A1E1B'),
          },
        },
        shadows: {
          card: dual('0 1px 2px rgba(39, 35, 47, 0.02)', '0 1px 2px rgba(0, 0, 0, 0.12)'),
          overlay: dual('-12px 0 32px rgba(31, 29, 25, 0.14)', '-12px 0 32px rgba(0, 0, 0, 0.55)'),
        },
      },
    },
  },
});
