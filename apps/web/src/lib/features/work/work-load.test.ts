import { describe, expect, test } from 'bun:test';
import { projectFocusedSupport } from '@ai-usage/report-core/focused-report-query';
import {
  parseSessionQueryRequest,
  projectSessionCampaignChildren,
  projectSessionPage,
} from '@ai-usage/report-core/session-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { InfiniteQueryObserver, keepPreviousData, QueryObserver } from '@tanstack/svelte-query';
import { demoReportPayload } from '../../../report-data';
import { createHydratedWebQueryClient } from '../../query/client';
import { retainedCampaignOptions } from '../../query/options/campaigns';
import { sessionCampaignInfiniteOptions } from '../../query/options/session-window';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { loadWorkPageData } from './work-load';
import { WORK_PAGE_SIZE, workRequest, workSessionsOptions } from './work-query';
import { WORK_DEMO_REVISION } from './work-synthetic';

const revision = 'work-ssr-fixture';
const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
const bootstrap: Extract<ReportRevisionBootstrapResult, { ok: true }> = {
  bootstrap: projectFocusedSupport(support, { harness: [], machine: [], truncated: false }, { revision }),
  manifest: {
    captureFingerprint: 'c'.repeat(64),
    expiresAt: 2,
    generatedAt: demoReportPayload.generatedAt,
    publishedAt: 1,
    revision,
    rowsBytes: 1,
    supportBytes: 1,
  },
  ok: true,
  requestFingerprint: 'report-manifest:v1:{}',
};
const sample = demoReportPayload.rows[0]!;
const rows = Array.from({ length: 70 }, (_, index) => ({
  ...sample,
  source: { ...sample.source!, sourceSessionId: `root-${index}`, rootSourceSessionId: `root-${index}` },
}));

describe('Work bounded stored metadata and Query hydration', () => {
  test.each([
    'QueryFailed',
    'RevisionExpired',
  ] as const)('SSR retains a typed visible %s failure and successful bootstrap for a later retry', async (tag) => {
    const paths: string[] = [];
    const data = await loadWorkPageData(
      {
        url: new URL('http://work.invalid/work'),
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          paths.push(pathname);
          if (pathname === '/rpc/report/revisionBootstrap') {
            return Response.json(serializer.serialize(bootstrap));
          }
          const input = parseSessionQueryRequest(serializer.deserialize(await request.json()));
          const projected = projectSessionPage(rows, input);
          return Response.json(
            serializer.serialize({
              ok: false,
              revision,
              requestFingerprint: projected.requestFingerprint,
              error: { tag, revision, message: 'Synthetic bounded failure' },
            }),
          );
        },
      },
      'live',
    );
    expect(paths).toEqual(['/rpc/report/revisionBootstrap', '/rpc/session/page']);
    expect(data.initialFailure?.kind).toBe(tag === 'RevisionExpired' ? 'revision-expired' : 'session-unavailable');
    expect(data.initialFailure?.message.length).toBeGreaterThan(0);
    expect(data.queryState.dehydratedState.queries.some((query) => query.queryKey.includes('report-bootstrap'))).toBe(
      true,
    );
    const cache = createHydratedWebQueryClient(data.queryState);
    const forbidden = (): Promise<never> => Promise.reject(new Error('No details during recovery'));
    const client: SessionClientAdapter = {
      campaignChildren: forbidden,
      detail: forbidden,
      lookup: forbidden,
      neighbors: forbidden,
      vcs: forbidden,
      page: (input) => {
        const page = projectSessionPage(rows, input);
        return Promise.resolve({
          ok: true,
          data: page,
          revision: page.revision,
          requestFingerprint: page.requestFingerprint,
        });
      },
    };
    try {
      const recovered = await cache.fetchInfiniteQuery(workSessionsOptions(client, revision));
      expect(recovered.pages[0]?.items).toHaveLength(WORK_PAGE_SIZE);
    } finally {
      cache.clear();
    }
  });
  test('SSR transport failure becomes a visible bootstrap failure rather than fake empty work', async () => {
    const data = await loadWorkPageData(
      {
        url: new URL('http://work.invalid/work'),
        fetch: () => Promise.reject(new Error('synthetic private transport detail')),
      },
      'live',
    );
    expect(data.initialFailure?.kind).toBe('bootstrap-unavailable');
    expect(data.queryState.dehydratedState.queries).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('synthetic private transport detail');
  });
  test('display-row activity can belong to a later child, never claims a root-only timestamp', () => {
    const root = {
      ...sample,
      source: { ...sample.source!, sourceSessionId: 'chronology-root', rootSourceSessionId: 'chronology-root' },
    };
    const child = {
      ...sample,
      name: 'Synthetic later child',
      origin: 'subagent' as const,
      date: '2026-06-11T10:00:00.000Z',
      endDate: '2026-06-11T11:00:00.000Z',
      activeDate: '2026-06-11T11:00:00.000Z',
      source: {
        ...sample.source!,
        sourceSessionId: 'chronology-child',
        parentSourceSessionId: 'chronology-root',
        rootSourceSessionId: 'chronology-root',
      },
    };
    const projected = projectSessionPage([root, child], workRequest(revision));
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]?.row.source?.sourceSessionId).toBe('chronology-root');
    expect(projected.items[0]?.row.activeDate).toBe(child.activeDate);
    expect(projected.items[0]?.row.activeDate).not.toBe(root.activeDate);
  });
  test('retains readable Query data through pending and failed publication replacement, with children on its own revision', async () => {
    const queryClient = createHydratedWebQueryClient({ dehydratedState: { queries: [], mutations: [] } });
    const reads: string[] = [];
    let rejectReplacement: (error: Error) => void = () => {
      throw new Error('No pending replacement');
    };
    const replacement = new Promise<never>((_resolve, reject) => {
      rejectReplacement = reject;
    });
    const forbidden = (): Promise<never> => Promise.reject(new Error('Unexpected detail acquisition'));
    const client: SessionClientAdapter = {
      detail: forbidden,
      lookup: forbidden,
      neighbors: forbidden,
      vcs: forbidden,
      page: (input) => {
        reads.push(input.revision);
        if (input.revision === 'replacement-revision') {
          return replacement;
        }
        const data = projectSessionPage(rows, input);
        return Promise.resolve({
          ok: true,
          data,
          revision: data.revision,
          requestFingerprint: data.requestFingerprint,
        });
      },
      campaignChildren: (input) => {
        reads.push(`children:${input.query.revision}`);
        const data = projectSessionCampaignChildren(rows, input);
        return Promise.resolve({
          ok: true,
          data,
          revision: data.revision,
          requestFingerprint: data.requestFingerprint,
        });
      },
    };
    const initialOptions = workSessionsOptions(client, revision);
    const initial = await queryClient.fetchInfiniteQuery(initialOptions);
    const retained = new QueryObserver(queryClient, retainedCampaignOptions<typeof initial>(initialOptions.queryKey));
    const stopRetained = retained.subscribe(() => undefined);
    const observer = new InfiniteQueryObserver(queryClient, { ...initialOptions, placeholderData: keepPreviousData });
    const stopCurrent = observer.subscribe(() => undefined);
    try {
      observer.setOptions({
        ...workSessionsOptions(client, 'replacement-revision'),
        placeholderData: keepPreviousData,
      });
      expect(observer.getCurrentResult().data?.pages[0]?.revision).toBe(revision);
      const settled = observer.refetch({ throwOnError: false });
      rejectReplacement(new Error('Stored replacement temporarily unavailable'));
      await settled;
      expect(observer.getCurrentResult().error?.message).toContain('temporarily unavailable');
      const visible = observer.getCurrentResult().data ?? retained.getCurrentResult().data;
      expect(visible?.pages[0]?.revision).toBe(revision);
      await queryClient.fetchInfiniteQuery(
        sessionCampaignInfiniteOptions(
          client,
          workRequest(visible!.pages[0]!.revision),
          initial.pages[0]!.items[0]!.campaignKey,
          'campaign-sessions',
        ),
      );
      expect(reads).toEqual([revision, 'replacement-revision', `children:${revision}`]);
    } finally {
      stopCurrent();
      stopRetained();
      queryClient.clear();
    }
  });
  test('live SSR reads one bootstrap and one bounded page, never native history, children, quota collection or commands', async () => {
    const paths: string[] = [];
    const data = await loadWorkPageData(
      {
        url: new URL('http://work.invalid/work'),
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          paths.push(pathname);
          if (pathname === '/rpc/report/revisionBootstrap') {
            return Response.json(serializer.serialize(bootstrap));
          }
          if (pathname !== '/rpc/session/page') {
            throw new Error(`Unexpected acquisition: ${pathname}`);
          }
          const input = parseSessionQueryRequest(serializer.deserialize(await request.json()));
          expect(input.pageSize).toBe(WORK_PAGE_SIZE);
          expect(input.revision).toBe(revision);
          expect(input.cursor).toBeNull();
          const page = projectSessionPage(rows, input);
          return Response.json(
            serializer.serialize({ data: page, ok: true, revision, requestFingerprint: page.requestFingerprint }),
          );
        },
      },
      'live',
    );
    expect(paths).toEqual(['/rpc/report/revisionBootstrap', '/rpc/session/page']);
    const queryClient = createHydratedWebQueryClient(data.queryState);
    let reads = 0;
    const forbidden = (): Promise<never> => {
      reads++;
      return Promise.reject(new Error('Unexpected hydration read'));
    };
    const client: SessionClientAdapter = {
      page: forbidden,
      campaignChildren: forbidden,
      lookup: forbidden,
      neighbors: forbidden,
      detail: forbidden,
      vcs: forbidden,
    };
    const options = workSessionsOptions(client, revision);
    const observer = new InfiniteQueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const result = await queryClient.fetchInfiniteQuery(options);
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0]?.items).toHaveLength(WORK_PAGE_SIZE);
      expect(result.pages[0]?.nextCursor).not.toBeNull();
      expect(reads).toBe(0);
      expect(observer.getCurrentResult().isFetching).toBe(false);
      expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
  test('demo SSR is isolated from all real report and control transports', async () => {
    let reads = 0;
    const data = await loadWorkPageData(
      {
        url: new URL('http://work.invalid/work'),
        fetch: () => {
          reads++;
          throw new Error('No live reads in demo');
        },
      },
      'demo',
    );
    expect(reads).toBe(0);
    expect(data.mode).toBe('demo');
    expect(JSON.stringify(data.queryState)).toContain(WORK_DEMO_REVISION);
    expect(JSON.stringify(data.queryState)).not.toContain(revision);
  });
  test('query scope preserves distinct sessions on the same project and has an explicit page bound', () => {
    const page = projectSessionPage(rows, workRequest(revision));
    expect(page.itemCount).toBe(70);
    expect(page.items).toHaveLength(25);
    expect(new Set(page.items.map((item) => item.row.rowId)).size).toBe(25);
  });
});
