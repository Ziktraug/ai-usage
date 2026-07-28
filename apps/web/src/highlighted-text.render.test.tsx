import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { SESSION_LIST_LABEL_MAX_CODE_POINTS } from './session-list-label';

interface HighlightedTextProps {
  query: string;
  text: string;
}

const HIGHLIGHTED_NEEDLE_PATTERN = /<mark[^>]*>needle<\/mark>/;

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/highlighted-text.tsx');
if (
  !(loaded && typeof loaded === 'object' && 'HighlightedText' in loaded && typeof loaded.HighlightedText === 'function')
) {
  throw new Error('Vite did not load HighlightedText');
}
const HighlightedText = loaded.HighlightedText as Component<HighlightedTextProps>;
afterAll(async () => viteServer.close());

describe('HighlightedText', () => {
  test('keeps a long Unicode session label bounded in rendered list text', () => {
    const overflow = 'tail beyond the Sessions list bound';
    const html = renderToString(() =>
      createComponent(HighlightedText, {
        query: '',
        text: `${'🧪'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS + 20)} ${overflow}`,
      }),
    );

    expect(html).toContain(`${'🧪'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS - 1)}…`);
    expect(html).not.toContain(overflow);
  });

  test('retains and highlights a query matched after the list-text bound', () => {
    const html = renderToString(() =>
      createComponent(HighlightedText, {
        query: 'needle',
        text: `${'🧪'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS + 20)} late needle context`,
      }),
    );

    expect(html).toMatch(HIGHLIGHTED_NEEDLE_PATTERN);
  });

  test('highlights with original offsets after an expanding Unicode case fold', () => {
    const html = renderToString(() =>
      createComponent(HighlightedText, {
        query: 'needle',
        text: `${'İ'.repeat(SESSION_LIST_LABEL_MAX_CODE_POINTS + 20)} late needle ${'tail'.repeat(100)}`,
      }),
    );

    expect(html).toMatch(HIGHLIGHTED_NEEDLE_PATTERN);
  });
});
