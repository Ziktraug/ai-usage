import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  activeReportTab,
  ensureHistoryEntryKey,
  isActiveManagementDestination,
  isManagementPath,
  navigationTypeForScroll,
  reportDestinationHeading,
  reportDestinationUrl,
  shouldPreserveReportScroll,
} from './navigation';

describe('Svelte application shell navigation', () => {
  test('reuses the frozen dashboard codec and preserves unrelated URL state', () => {
    const current = new URL('http://127.0.0.1/?tab=sessions&machine=%5B%22m1%22%5D&foreign=kept#anchor');
    const breakdown = reportDestinationUrl(current, 'breakdown');

    expect(breakdown.pathname).toBe('/');
    expect(activeReportTab(breakdown)).toBe('breakdown');
    expect(breakdown.searchParams.get('machine')).toBe('["m1"]');
    expect(breakdown.searchParams.get('foreign')).toBe('kept');
    expect(breakdown.hash).toBe('#anchor');
    expect(reportDestinationUrl(breakdown, 'overview').searchParams.has('tab')).toBe(false);
  });

  test('classifies management routes without matching similarly prefixed paths', () => {
    expect(isManagementPath('/skills/projects/demo')).toBe(true);
    expect(isManagementPath('/sources')).toBe(true);
    expect(isManagementPath('/skills-copy')).toBe(false);
    expect(isActiveManagementDestination('/sync/history', '/sync')).toBe(true);
    expect(isActiveManagementDestination('/synchronize', '/sync')).toBe(false);
  });

  test('owns stable history-entry keys and keeps existing page state', () => {
    let next = 0;
    const createKey = (): string => `entry-${++next}`;
    const first = ensureHistoryEntryKey({ retained: true }, createKey);
    const repeated = ensureHistoryEntryKey(first.state, createKey);

    expect(first).toEqual({ key: 'entry-1', state: { aiUsageNavigationKey: 'entry-1', retained: true } });
    expect(repeated.key).toBe('entry-1');
    expect(next).toBe(1);
  });

  test('adapts navigation kinds and preserves only intra-report scroll', () => {
    expect(navigationTypeForScroll('popstate')).toBe('popstate');
    expect(navigationTypeForScroll('unknown')).toBe('link');
    expect(
      shouldPreserveReportScroll(new URL('http://localhost/?tab=overview'), new URL('http://localhost/?tab=sessions')),
    ).toBe(true);
    expect(shouldPreserveReportScroll(new URL('http://localhost/'), new URL('http://localhost/skills'))).toBe(false);
  });

  test('keeps one hydrated retry and a same-URL progressive fallback', async () => {
    const shellSource = await readFile(new URL('./error-shell.svelte', import.meta.url), 'utf8');
    const routeSource = await readFile(new URL('../../../routes/+error.svelte', import.meta.url), 'utf8');
    const ownerSource = await readFile(new URL('./error-route-owner.svelte', import.meta.url), 'utf8');

    expect(shellSource).toContain('<form action={retryHref} class={retryForm} method="get" onsubmit={submitRetry}>');
    expect(shellSource).toContain('event.preventDefault();');
    expect(shellSource).toContain('retryParameters');
    expect(shellSource).toContain('type="hidden"');
    expect(shellSource).toContain('{name}');
    expect(shellSource).toContain('{value}');
    expect(shellSource).toContain('await onRetry();');
    expect(routeSource).toContain('<ErrorRouteOwner />');
    expect(ownerSource).toContain('window.location.reload();');
    expect(ownerSource).toContain('retryHref=');
    expect(ownerSource).toContain('page.url.pathname');
    expect(ownerSource).toContain('page.url.search');
    expect(ownerSource).not.toContain('invalidateAll');
  });
});

describe('report destination headings', () => {
  test('names the destination, never the product', () => {
    expect(reportDestinationHeading('overview')).toBe('Usage overview');
    expect(reportDestinationHeading('sessions')).toBe('Sessions');
    expect(reportDestinationHeading('breakdown')).toBe('Analysis');
  });
});
