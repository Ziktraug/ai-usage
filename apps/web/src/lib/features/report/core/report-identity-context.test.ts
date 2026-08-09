import { describe, expect, test } from 'bun:test';
import { createReportIdentityChannel, type ReportQueryIdentity } from './report-identity-context.svelte';

const identity = (revision: string, requestFingerprint: string): ReportQueryIdentity => ({
  requestFingerprint,
  revision,
});

describe('report identity channel', () => {
  test('publishes the accepted identity once and clears its exact owner', () => {
    const changes: Array<ReportQueryIdentity | undefined> = [];
    const channel = createReportIdentityChannel((next) => changes.push(next));
    const accepted = identity('revision-a', 'session-query-v1:accepted');

    channel.publish(accepted);
    channel.publish(accepted);
    channel.clear(accepted);

    expect(changes).toEqual([accepted, undefined]);
  });

  test('does not let stale cleanup clear a newer query identity', () => {
    const changes: Array<ReportQueryIdentity | undefined> = [];
    const channel = createReportIdentityChannel((next) => changes.push(next));
    const previous = identity('revision-a', 'session-query-v1:previous');
    const current = identity('revision-b', 'session-query-v1:current');

    channel.publish(previous);
    channel.publish(current);
    channel.clear(previous);

    expect(changes).toEqual([previous, current]);

    channel.clear(current);
    expect(changes).toEqual([previous, current, undefined]);
  });

  test('wires exact live and synthetic accepted session identities', async () => {
    const [liveSource, syntheticSource] = await Promise.all([
      Bun.file(new URL('../composition/sessions-destination.svelte', import.meta.url)).text(),
      Bun.file(new URL('../composition/synthetic-report-destination.svelte', import.meta.url)).text(),
    ]);

    expect(liveSource).toContain('<SessionIdentityPublisher');
    expect(liveSource).toContain('requestFingerprint={query ? sessionQueryFingerprint(query) : undefined}');
    expect(liveSource).toContain('revision={query?.revision}');
    expect(syntheticSource).toContain('<SessionIdentityPublisher');
    expect(syntheticSource).toContain('requestFingerprint={sessionQueryFingerprint(syntheticSessionQuery)}');
    expect(syntheticSource).toContain('revision={syntheticSessionQuery.revision}');
  });
});
