import { afterAll, describe, expect, test } from 'bun:test';
import type { SessionVcsContext, SessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';

interface SummaryProps {
  context: unknown;
  onResolve?: () => void;
  resolution: SessionVcsResolveResponse | null;
  resolving: boolean;
}

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/session-vcs-summary.tsx');
if (
  !(
    loaded &&
    typeof loaded === 'object' &&
    'SessionVcsSummary' in loaded &&
    typeof loaded.SessionVcsSummary === 'function'
  )
) {
  throw new Error('Vite did not load SessionVcsSummary');
}
const SessionVcsSummary = loaded.SessionVcsSummary as Component<SummaryProps>;
afterAll(async () => viteServer.close());

const context: SessionVcsContext = {
  branches: [
    {
      firstObservedAt: '2026-07-01T08:00:00.000Z',
      lastObservedAt: '2026-07-01T08:01:00.000Z',
      name: 'main',
      provenance: 'harness-recorded',
      webUrl: 'https://github.com/fixture/project/tree/main',
    },
    {
      firstObservedAt: '2026-07-01T08:02:00.000Z',
      lastObservedAt: '2026-07-01T08:03:00.000Z',
      name: 'topic/very-long-branch-name-that-must-not-overflow-the-drawer',
      provenance: 'harness-recorded',
      webUrl: 'https://github.com/fixture/project/tree/topic/very-long-branch-name-that-must-not-overflow-the-drawer',
    },
  ],
  headCommit: {
    hash: '0123456789abcdef0123456789abcdef01234567',
    observedAt: '2026-07-01T08:03:00.000Z',
    provenance: 'harness-recorded',
    webUrl: 'https://github.com/fixture/project/commit/0123456789abcdef0123456789abcdef01234567',
  },
  partial: false,
  pullRequests: [
    {
      number: 27,
      observedAt: '2026-07-01T08:04:00.000Z',
      repository: 'fixture/project',
      url: 'https://github.com/fixture/project/pull/27',
    },
  ],
  repository: {
    host: 'github.com',
    ownerPath: 'fixture/project',
    provenance: 'local-derived',
    webUrl: 'https://github.com/fixture/project',
  },
};

const render = (
  vcs: unknown = context,
  options: Partial<Pick<SummaryProps, 'resolution' | 'resolving' | 'onResolve'>> = {},
): string =>
  renderToString(() =>
    createComponent(SessionVcsSummary, {
      context: vcs,
      onResolve: options.onResolve ?? (() => undefined),
      resolution: options.resolution ?? null,
      resolving: options.resolving ?? false,
    }),
  );

describe('SessionVcsSummary', () => {
  test('renders safe accessible external links, multiple branches, commit, and recorded PR', () => {
    const html = render();
    expect(html).toContain('Session source control');
    expect(html).toContain('fixture/project');
    expect(html).toContain('main');
    expect(html).toContain('topic/very-long-branch-name');
    expect(html).toContain('01234567');
    expect(html).toContain('title="0123456789abcdef0123456789abcdef01234567"');
    expect(html).toContain('#27');
    expect(html.match(/target="_blank"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html.match(/rel="noopener"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('aria-label="Open repository fixture/project in a new tab"');
    expect(html).toContain('<svg');
    expect(html).toContain('<details');
    expect(html).toContain('Repository derived from the recorded local checkout.');
    expect(html).not.toContain('Resolve GitHub links');
  });

  test('renders missing URLs as text and offers an explicit resolver only when useful', () => {
    const withoutUrls: SessionVcsContext = {
      ...context,
      branches: context.branches.slice(0, 1).map((branch) => ({ ...branch, webUrl: null })),
      headCommit: null,
      pullRequests: [],
      repository: { ...context.repository!, host: 'github-work', webUrl: null },
    };
    const html = render(withoutUrls);
    expect(html).toContain('fixture/project');
    expect(html).toContain('main');
    expect(html).not.toContain('href=');
    expect(html).toContain('Resolve GitHub links');
    expect(html).toContain('aria-label="Resolve GitHub repository and pull request links"');

    const noRepository = render({ ...withoutUrls, repository: null });
    expect(noRepository).not.toContain('Resolve GitHub links');
  });

  test('renders pending, failure, retry, and ephemeral success without layout-triggered lookup', () => {
    let resolutionRequests = 0;
    expect(
      render(
        { ...context, pullRequests: [] },
        {
          onResolve: () => {
            resolutionRequests += 1;
          },
          resolving: true,
        },
      ),
    ).toContain('Resolving GitHub links…');
    expect(resolutionRequests).toBe(0);
    const failed = render(
      { ...context, pullRequests: [] },
      { resolution: { reason: 'timed-out', status: 'unavailable' } },
    );
    expect(failed).toContain('GitHub lookup timed out.');
    expect(failed).toContain('Retry GitHub lookup');
    const success = render(
      { ...context, pullRequests: [] },
      {
        resolution: {
          pullRequests: [
            {
              number: 42,
              observedAt: null,
              repository: 'fixture/project',
              url: 'https://github.com/fixture/project/pull/42',
            },
          ],
          repositoryUrl: 'https://github.com/fixture/project',
          status: 'available',
        },
      },
    );
    expect(success).toContain('#42');
    expect(success).not.toContain('Resolve GitHub links');
  });

  test('rejects unsafe or malformed contexts instead of rendering dangerous actions', () => {
    const unsafe = {
      ...context,
      repository: { ...context.repository, webUrl: 'javascript:private' },
    };
    const html = render(unsafe);
    expect(html).toBe('');
    expect(html).not.toContain('PRIVATE');
    expect(html).not.toContain('javascript:');
  });

  test('renders targeted neutral context notes without global warnings', () => {
    const html = render({ ...context, partial: true });
    expect(html).toContain('Some recorded source-control context could not be represented safely.');
    expect(html).not.toContain('role="alert"');
  });
});
