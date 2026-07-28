import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { CampaignLabelEditorState } from './campaign-label-editor';

interface RenderedCampaignLabelEditorProps {
  editor: CampaignLabelEditorState;
}

const isCampaignLabelEditorModule = (
  value: unknown,
): value is { CampaignLabelEditor: Component<RenderedCampaignLabelEditorProps> } =>
  typeof value === 'object' &&
  value !== null &&
  'CampaignLabelEditor' in value &&
  typeof value.CampaignLabelEditor === 'function';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loadedModule: unknown = await viteServer.ssrLoadModule('/src/campaign-label-editor.tsx');
if (!isCampaignLabelEditorModule(loadedModule)) {
  throw new Error('Vite did not load the campaign label editor');
}
const CampaignLabelEditor: Component<RenderedCampaignLabelEditorProps> = loadedModule.CampaignLabelEditor;
afterAll(async () => {
  await viteServer.close();
});

const editorState = (overrides: Partial<CampaignLabelEditorState> = {}): CampaignLabelEditorState => ({
  campaignKey: 'fixture-machine:codex:campaign-root',
  effectiveLabel: 'Release train',
  hasOverride: true,
  loadError: null,
  loadStatus: 'ready',
  mutationError: null,
  mutationStatus: 'idle',
  onRename: async (label) => label,
  onReset: async () => 'Build report UI',
  onRetry: () => undefined,
  ...overrides,
});

const renderEditor = (editor: CampaignLabelEditorState): string =>
  renderToString(() => createComponent(CampaignLabelEditor, { editor }));

const buttonMarkup = (html: string, label: string): string => {
  const labelIndex = html.indexOf(`>${label}</button>`);
  const start = html.lastIndexOf('<button', labelIndex);
  if (labelIndex < 0 || start < 0) {
    throw new Error(`Missing rendered button: ${label}`);
  }
  return html.slice(start, labelIndex + `>${label}</button>`.length);
};

describe('SessionDrawer campaign label editor', () => {
  test('renders a labelled keyboard-operable editor from the effective campaign label', () => {
    const html = renderEditor(editorState());

    expect(html).toContain('data-campaign-label-editor');
    expect(html).toContain('for="session-drawer-campaign-label"');
    expect(html).toContain('id="session-drawer-campaign-label"');
    expect(html).toContain('value="Release train"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-campaign-label-status');
    expect(buttonMarkup(html, 'Rename')).toContain('disabled');
    expect(buttonMarkup(html, 'Reset')).not.toContain('disabled');
    expect(html.indexOf('data-campaign-label-status')).toBeGreaterThan(html.indexOf('>Reset</button>'));
  });

  test('renders independent load and mutation failures plus a retry control', () => {
    const html = renderEditor(
      editorState({
        loadError: 'fixture load failed',
        loadStatus: 'error',
        mutationError: 'fixture save failed',
        mutationStatus: 'error',
      }),
    );

    expect(html).toContain('Unable to load campaign labels:');
    expect(html).toContain('fixture load failed');
    expect(html).toContain('Retry labels');
    expect(html).toContain('Unable to save campaign label:');
    expect(html).toContain('fixture save failed');
  });

  test('disables both mutations and announces pending state while saving', () => {
    const html = renderEditor(editorState({ mutationStatus: 'saving' }));

    expect(buttonMarkup(html, 'Rename')).toContain('disabled');
    expect(buttonMarkup(html, 'Reset')).toContain('disabled');
    expect(html).toContain('Saving campaign label…');
  });
});
