import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';

interface DrawerDetailItemProps {
  hint?: string;
  label: string;
  value: string;
}

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/drawer-detail-item.tsx');
if (
  !(
    loaded &&
    typeof loaded === 'object' &&
    'DrawerDetailItem' in loaded &&
    typeof loaded.DrawerDetailItem === 'function'
  )
) {
  throw new Error('Vite did not load DrawerDetailItem');
}
const DrawerDetailItem = loaded.DrawerDetailItem as Component<DrawerDetailItemProps>;
afterAll(async () => viteServer.close());

const render = (props: DrawerDetailItemProps): string => renderToString(() => createComponent(DrawerDetailItem, props));

describe('DrawerDetailItem', () => {
  test('renders a named interactive information trigger when provenance exists', () => {
    const html = render({
      hint: 'Cursor export value covered by the subscription quota',
      label: 'Sub value',
      value: '$12.00',
    });

    expect(html).toContain('data-detail-item="Sub value"');
    expect(html).toContain('aria-label="About Sub value"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('>i</span>');
  });

  test('does not add an information control without an explanation', () => {
    const html = render({ label: 'Calls', value: '3' });

    expect(html).not.toContain('aria-label="About Calls"');
  });
});
