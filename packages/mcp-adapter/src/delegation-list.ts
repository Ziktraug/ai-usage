import { mcpToolOutputBounds, retrievedDataNotice } from './tool-result';

/**
 * The `delegation.list` answer under the tool bound. A port answers up to fifty summaries, each
 * carrying a checkout path of up to the request bound and the frozen scope, so the whole list can
 * pass `mcpToolOutputBounds.maxOutputBytes`; a list that does is cut at its tail (the oldest jobs),
 * never inside a summary, and the jobs left out are counted in `omitted`. The size measured is the
 * one `safeToolResult` measures: the UTF-8 bytes of the serialized payload, envelope included.
 */

export interface DelegationMcpJobList {
  /**
   * One compact summary per job, newest first (the composition builds them with report-core's
   * `summarizeDelegationJobView`; the adapter forwards them whole), the frozen scope as recorded
   * included. The full job view is `delegation.status`'s.
   */
  readonly jobs: readonly object[];
  /** Jobs the port left out of `jobs` before the adapter's bound; the adapter adds the ones it drops. */
  readonly omitted: number;
  readonly skipped: number;
  readonly truncated: boolean;
}

/** The tool payload exactly as `delegation.list` serializes it. */
export interface DelegationMcpListPayload {
  readonly contentRole: 'retrieved-data';
  readonly jobs: readonly object[];
  readonly notice: typeof retrievedDataNotice;
  /** Jobs beyond the response bound or left out by the port; each is readable with `delegation.status`. */
  readonly omitted: number;
  readonly skipped: number;
  readonly truncated: boolean;
}

const utf8Bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Keeps the longest prefix (the newest jobs) of `list.jobs` whose serialized payload, envelope
 * included, stays within `mcpToolOutputBounds.maxOutputBytes`; the rest are counted in `omitted`
 * together with what the port already left out. A summary is kept whole or not at all.
 */
export const boundDelegationListPayload = (list: DelegationMcpJobList): DelegationMcpListPayload => {
  const payload = (jobs: readonly object[], omitted: number): DelegationMcpListPayload => ({
    contentRole: 'retrieved-data',
    jobs,
    notice: retrievedDataNotice,
    omitted,
    skipped: list.skipped,
    truncated: list.truncated,
  });
  // The envelope with no job and the largest `omitted` the answer can carry (the most digits): the
  // final envelope is never larger, so a prefix admitted here fits whatever `omitted` ends up being.
  let bytes = utf8Bytes(payload([], list.omitted + list.jobs.length));
  const kept: object[] = [];
  for (const job of list.jobs) {
    // The serialized summary, preceded by its separator once the array has an element.
    const size = utf8Bytes(job) + (kept.length === 0 ? 0 : 1);
    if (bytes + size > mcpToolOutputBounds.maxOutputBytes) {
      break;
    }
    kept.push(job);
    bytes += size;
  }
  return payload(kept, list.omitted + list.jobs.length - kept.length);
};
