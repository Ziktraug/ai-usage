import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,tsx}'],
  exclude: [],
  jsxFramework: 'solid',
  outdir: 'styled-system',
  theme: {
    extend: {
      tokens: {
        colors: {
          ink: { value: '#15201b' },
          muted: { value: '#60716a' },
          surface: { value: '#ffffff' },
          canvas: { value: '#f4f7f3' },
          line: { value: '#d9e2dc' },
          mint: { value: '#0f8b6d' },
          teal: { value: '#0d6986' },
          amber: { value: '#bc7a15' },
          rose: { value: '#a83f5f' },
        },
      },
    },
  },
});
