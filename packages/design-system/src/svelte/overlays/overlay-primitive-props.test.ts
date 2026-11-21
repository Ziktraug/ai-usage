import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component, Snippet } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer, type Plugin } from 'vite';

/**
 * Tooltip and Popover hand their open timing, mount lifecycle and portal to Ark. A server render
 * cannot open them, so here the Ark modules they import are replaced by recording parts: each part
 * records the props the overlay passes and renders its children inside a marked element. What this
 * pins is the contract with the primitive (the 300 ms default delay, lazy mount, unmount on exit,
 * content inside the portal); Ark's own behaviour is not re-tested.
 */
const OVERLAY_DIRECTORY = '/packages/design-system/src/svelte/overlays/';
const RECORDER_ID = '\0ark-recorder';
const PART_PREFIX = '\0ark-part:';
const STUB_PREFIX = '\0ark-stub:';
const PRIMITIVE_PARTS = {
  popover: ['Root', 'Trigger', 'Positioner', 'Content'],
  tooltip: ['Root', 'Trigger', 'Positioner', 'Content'],
} as const;
type Primitive = keyof typeof PRIMITIVE_PARTS;
/** Only the two overlays under test get the recording parts; every other Ark import stays real. */
const RECORDED_OVERLAY_PATTERN = /\/overlays\/(popover|tooltip)\.svelte/;
const RECORDED_PRIMITIVE_PATTERN = /^@ark-ui\/svelte\/(popover|portal|tooltip)$/;

const partSource = (part: string): string => `<script>
  import { record } from '${RECORDER_ID}';
  let { asChild, children, ...props } = $props();
  record('${part}', props);
</script>
<div data-recorded-part="${part}">{#if asChild}{@render asChild(() => ({ 'data-recorded-trigger': '${part}' }))}{/if}{@render children?.()}</div>
`;

const stubModule = (id: string): string => {
  if (id === 'portal') {
    return `export { default as Portal } from '${PART_PREFIX}portal';`;
  }
  const parts = PRIMITIVE_PARTS[id as Primitive];
  const imports = parts.map((part) => `import ${part} from '${PART_PREFIX}${id}.${part}';`).join('\n');
  const namespace = `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  return `${imports}\nexport const ${namespace} = { ${parts.join(', ')} };`;
};

const recordingArkPlugin: Plugin = {
  enforce: 'pre',
  load: (id) => {
    if (id === RECORDER_ID) {
      return 'export const records = [];\nexport const record = (part, props) => { records.push({ part, props: { ...props } }); };';
    }
    if (id.startsWith(PART_PREFIX)) {
      const part = id.slice(PART_PREFIX.length);
      return compile(partSource(part), { dev: true, filename: `${part}.svelte`, generate: 'server' }).js.code;
    }
    if (id.startsWith(STUB_PREFIX)) {
      return stubModule(id.slice(STUB_PREFIX.length));
    }
  },
  name: 'recording-ark-primitives',
  resolveId: (id, importer) => {
    if (id === RECORDER_ID || id.startsWith(PART_PREFIX)) {
      return id;
    }
    const overlay = importer?.match(RECORDED_OVERLAY_PATTERN)?.[1];
    const primitive = id.match(RECORDED_PRIMITIVE_PATTERN)?.[1];
    return overlay && primitive ? `${STUB_PREFIX}${primitive}` : undefined;
  },
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [recordingArkPlugin, svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());

interface RecordedPart {
  readonly part: string;
  readonly props: Record<string, unknown>;
}

const [tooltipModule, popoverModule, recorderModule, serverModule, svelteModule] = await Promise.all([
  viteServer.ssrLoadModule(`${OVERLAY_DIRECTORY}tooltip.svelte`),
  viteServer.ssrLoadModule(`${OVERLAY_DIRECTORY}popover.svelte`),
  viteServer.ssrLoadModule(RECORDER_ID),
  viteServer.ssrLoadModule('svelte/server'),
  viteServer.ssrLoadModule('svelte'),
]);
const Tooltip = Reflect.get(tooltipModule, 'default') as Component<Record<string, unknown>>;
const Popover = Reflect.get(popoverModule, 'default') as Component<Record<string, unknown>>;
const records = Reflect.get(recorderModule, 'records') as RecordedPart[];
const render = Reflect.get(serverModule, 'render') as (
  component: Component<Record<string, unknown>>,
  options: { props: Record<string, unknown> },
) => { body: string };
const createRawSnippet = Reflect.get(svelteModule, 'createRawSnippet') as <Arguments extends unknown[]>(
  create: (...getters: { [Index in keyof Arguments]: () => Arguments[Index] }) => { render: () => string },
) => Snippet<Arguments>;

const textSnippet = (html: string): Snippet => createRawSnippet(() => ({ render: () => html }));
const triggerSnippet = createRawSnippet<[Record<string, unknown>]>((getProps) => ({
  render: () => `<button data-trigger-received="${Object.keys(getProps()).join(' ')}" type="button">Target</button>`,
}));

/** Renders an overlay and returns its markup (comments removed) and the props of every primitive part. */
const renderOverlay = (
  overlay: Component<Record<string, unknown>>,
  props: Record<string, unknown>,
): { readonly html: string; readonly propsOf: (part: string) => Record<string, unknown> | undefined } => {
  records.length = 0;
  const html = render(overlay, { props }).body.replaceAll(/<!--[^>]*-->/g, '');
  return { html, propsOf: (part) => records.find((record) => record.part === part)?.props };
};

const portalledContentPattern = (primitive: Primitive): RegExp =>
  new RegExp(
    `<div data-recorded-part="portal"><div data-recorded-part="${primitive}.Positioner"[^>]*>` +
      `<div data-recorded-part="${primitive}.Content"[^>]*>`,
  );

beforeEach(() => {
  records.length = 0;
});

describe('Tooltip hands Ark its timing, lifecycle and portal', () => {
  test('opens after the 300 ms default delay, mounts lazily and unmounts on exit', () => {
    const { propsOf } = renderOverlay(Tooltip, { content: 'Tip', trigger: triggerSnippet });

    expect(propsOf('tooltip.Root')).toEqual({ lazyMount: true, openDelay: 300, unmountOnExit: true });
  });

  test('passes a caller delay through instead of the default', () => {
    const { propsOf } = renderOverlay(Tooltip, { content: 'Tip', openDelay: 50, trigger: triggerSnippet });

    expect(propsOf('tooltip.Root')?.openDelay).toBe(50);
  });

  test('renders its positioned content inside the portal and its trigger as the caller element', () => {
    const { html } = renderOverlay(Tooltip, { content: 'Tip', trigger: triggerSnippet });

    expect(html).toMatch(portalledContentPattern('tooltip'));
    expect(html).toContain('<button data-trigger-received="data-recorded-trigger" type="button">Target</button>');
  });
});

describe('Popover hands Ark its lifecycle and portal', () => {
  const popoverProps = {
    children: textSnippet('<span>Popover body</span>'),
    contentAriaLabel: 'Fixture actions',
    trigger: textSnippet('<span>Open</span>'),
  };

  test('mounts lazily, unmounts on exit and keeps its default gutter', () => {
    const { propsOf } = renderOverlay(Popover, popoverProps);

    expect(propsOf('popover.Root')).toMatchObject({ lazyMount: true, positioning: { gutter: 4 }, unmountOnExit: true });
  });

  test('renders its named content inside the portal', () => {
    const { html, propsOf } = renderOverlay(Popover, popoverProps);

    expect(html).toMatch(portalledContentPattern('popover'));
    expect(propsOf('popover.Content')).toMatchObject({ 'aria-label': 'Fixture actions' });
  });
});
