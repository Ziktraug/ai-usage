import { afterAll, expect, test } from 'bun:test';
import type { SkillDiagnostic } from '@ai-usage/skills';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';

interface SkillDiagnosticsProps {
  diagnostics: readonly SkillDiagnostic[];
}

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loadedModule: unknown = await viteServer.ssrLoadModule('/src/skill-diagnostics.tsx');
if (
  !(
    loadedModule &&
    typeof loadedModule === 'object' &&
    'SkillDiagnostics' in loadedModule &&
    typeof loadedModule.SkillDiagnostics === 'function'
  )
) {
  throw new Error('Vite did not load the Skills diagnostics renderer');
}
const SkillDiagnostics = loadedModule.SkillDiagnostics as Component<SkillDiagnosticsProps>;
afterAll(async () => viteServer.close());

test('renders project token diagnostics with human labels and structured measurements', () => {
  const html = renderToString(() =>
    createComponent(SkillDiagnostics, {
      diagnostics: [
        {
          code: 'SkillMarkdownTokenWarning',
          message: 'SKILL.md is approaching the recommended token limit.',
          severity: 'warning',
          tokenMeasurement: { observed: 1240, threshold: 1000, unit: 'tokens' },
        },
      ],
    }),
  );
  const visibleHtml = html.replaceAll('<!--#-->', '').replaceAll('<!--$-->', '').replaceAll('<!--/-->', '');

  expect(visibleHtml).toContain('Skill document token warning');
  expect(visibleHtml).not.toContain('>SkillMarkdownTokenWarning<');
  expect(visibleHtml).toContain('data-token-measurement');
  expect(visibleHtml).toContain('1,240 / 1,000 tokens');
});
