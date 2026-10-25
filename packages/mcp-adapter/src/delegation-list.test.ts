import { describe, expect, test } from 'bun:test';
import { boundDelegationListPayload, type DelegationMcpJobList } from './delegation-list';
import { mcpToolOutputBounds, retrievedDataNotice } from './tool-result';

const BOUND = mcpToolOutputBounds.maxOutputBytes;

const utf8Bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** A summary-shaped entry whose serialized size is governed by `checkoutPath`. */
const summary = (index: number, checkoutPath: string) => ({
  checkoutPath,
  frozenScope: { base: 'first-parent', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), kind: 'commit' },
  jobId: `0f2c2b0e-6b1a-4c3e-9f1d-${String(index).padStart(12, '0')}`,
  state: 'finished',
});

const list = (jobs: readonly object[], extra: Partial<DelegationMcpJobList> = {}): DelegationMcpJobList => ({
  jobs,
  omitted: 0,
  skipped: 0,
  truncated: false,
  ...extra,
});

describe('boundDelegationListPayload', () => {
  test('forwards a list that fits untouched, inside the exact tool envelope', () => {
    const jobs = Array.from({ length: 50 }, (_, index) => summary(index, '/home/operator/src/project'));
    const payload = boundDelegationListPayload(list(jobs, { omitted: 2, skipped: 1, truncated: true }));
    expect(payload).toEqual({
      contentRole: 'retrieved-data',
      jobs,
      notice: retrievedDataNotice,
      omitted: 2,
      skipped: 1,
      truncated: true,
    });
    expect(Object.keys(payload)).toEqual(['contentRole', 'jobs', 'notice', 'omitted', 'skipped', 'truncated']);
    expect(payload.jobs[0]).toBe(jobs[0]);
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(BOUND);
  });

  test('cuts a list that does not fit at its tail: the newest whole summaries, the rest counted in omitted', () => {
    // Fifty 4 KiB paths: about 210 KiB of summaries, past the 192 KiB bound.
    const jobs = Array.from({ length: 50 }, (_, index) => summary(index, `/${'p'.repeat(4095)}`));
    expect(utf8Bytes(list(jobs))).toBeGreaterThan(BOUND);
    const payload = boundDelegationListPayload(list(jobs, { omitted: 3 }));
    expect(payload.jobs.length).toBeGreaterThan(0);
    expect(payload.jobs.length).toBeLessThan(jobs.length);
    expect(payload.omitted).toBe(3 + jobs.length - payload.jobs.length);
    // A prefix, each entry the very object the port answered: nothing is cut inside a summary.
    expect(payload.jobs.every((job, index) => job === jobs[index])).toBe(true);
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(BOUND);
    // The cut is tight: one more summary would pass the bound.
    const oneMore = { ...payload, jobs: jobs.slice(0, payload.jobs.length + 1) };
    expect(utf8Bytes(oneMore)).toBeGreaterThan(BOUND);
  });

  test('measures UTF-8 bytes, not characters: multibyte paths count by their encoded size', () => {
    // 4096 characters each; two bytes per character puts fifty of them well past the bound, where
    // the same count of one-byte characters fits.
    const narrow = Array.from({ length: 24 }, (_, index) => summary(index, `/${'p'.repeat(4095)}`));
    const wide = Array.from({ length: 24 }, (_, index) => summary(index, `/${'é'.repeat(4095)}`));
    expect(JSON.stringify(wide).length).toBe(JSON.stringify(narrow).length);
    const narrowPayload = boundDelegationListPayload(list(narrow));
    expect(narrowPayload.jobs).toHaveLength(24);
    expect(narrowPayload.omitted).toBe(0);
    const widePayload = boundDelegationListPayload(list(wide));
    expect(widePayload.jobs.length).toBeLessThan(24);
    expect(widePayload.omitted).toBe(24 - widePayload.jobs.length);
    expect(utf8Bytes(widePayload)).toBeLessThanOrEqual(BOUND);
    expect(JSON.parse(JSON.stringify(widePayload)).jobs[0].checkoutPath).toBe(`/${'é'.repeat(4095)}`);
  });

  test('never cuts inside a summary: an entry that cannot fit alone is counted, not trimmed', () => {
    const oversized = { ...summary(0, '/x'), blob: 'x'.repeat(BOUND) };
    const payload = boundDelegationListPayload(list([oversized, summary(1, '/y')]));
    // The newest entry does not fit, so the prefix is empty; an older one is never promoted past it.
    expect(payload.jobs).toEqual([]);
    expect(payload.omitted).toBe(2);
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(BOUND);
  });

  test('counts the digits of omitted in the envelope: an admitted answer never grows past the bound', () => {
    // One entry sized to fill the bound exactly beside a one-digit `omitted`. Listed with ten older
    // entries, keeping it would leave a two-digit `omitted` and one byte too many, so it is not kept.
    const probe = summary(0, '/a');
    const envelope = utf8Bytes(boundDelegationListPayload(list([])));
    const filler = summary(0, `/${'p'.repeat(BOUND - envelope - utf8Bytes(probe) + 1)}`);
    expect(envelope + utf8Bytes(filler)).toBe(BOUND);
    const alone = boundDelegationListPayload(list([filler]));
    expect(alone.jobs).toEqual([filler]);
    expect(utf8Bytes(alone)).toBe(BOUND);
    const older = Array.from({ length: 10 }, (_, index) => summary(index + 1, '/b'));
    const payload = boundDelegationListPayload(list([filler, ...older]));
    expect(payload.jobs).toEqual([]);
    expect(payload.omitted).toBe(11);
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(BOUND);
  });
});
