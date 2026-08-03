import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import type { ServedReportRefreshOutcome, ServedReportSession } from '../../../../served-report-session';

describe('ServedReportSession rune owner', () => {
  it('is a thin rune module and delegates lifecycle policy to the injected deep session', async () => {
    const sourcePath = new URL('./served-report-session-owner.svelte.ts', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    expect(source).toContain('$state<ServedReportOwnerSnapshot<Descriptor>>');
    expect(source).toContain('await session.refresh(destination)');
    expect(source).not.toContain('AbortController');
    expect(source).not.toContain('isRevisionExpired');
    expect(source).not.toContain('requestId');
  });

  it('keeps the deep session outcome shape unchanged at the adapter boundary', async () => {
    const outcome: ServedReportRefreshOutcome = {
      descriptor: { captureFingerprint: 'capture-a', revision: 'revision-a' },
      status: 'committed',
    };
    const session: ServedReportSession<string> = {
      abort: () => undefined,
      refresh: () => Promise.resolve(outcome),
    };

    expect(await session.refresh('overview')).toEqual(outcome);
  });
});
