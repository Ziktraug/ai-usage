import { describe, expect, test } from 'bun:test';
import { createServedReportSession, type ServedRevisionDescriptor } from './served-report-session';

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const descriptor = (revision: string, captureFingerprint = revision): ServedRevisionDescriptor => ({
  captureFingerprint,
  revision,
});

describe('served report session', () => {
  test('prevents an older destination from committing after a newer request', async () => {
    const oldLoad = deferred<string>();
    const commits: string[] = [];
    const session = createServedReportSession<string, string>({
      acquire: () => Promise.resolve(descriptor('r1')),
      commit: (prepared) => commits.push(prepared),
      destinationFingerprint: (destination: string) => destination,
      isRevisionExpired: () => false,
      load: (destination: string) => (destination === 'old' ? oldLoad.promise : Promise.resolve(destination)),
    });

    const oldResult = session.refresh('old');
    expect((await session.refresh('new')).status).toBe('committed');
    oldLoad.resolve('old');
    expect((await oldResult).status).toBe('superseded');
    expect(commits).toEqual(['new']);
  });

  test('suppresses only an identical revision, capture, and destination fingerprint', async () => {
    let loads = 0;
    const session = createServedReportSession<string, string>({
      acquire: () => Promise.resolve(descriptor('r1', 'capture')),
      commit: () => undefined,
      destinationFingerprint: (destination: string) => destination,
      isRevisionExpired: () => false,
      load: () => {
        loads += 1;
        return Promise.resolve('prepared');
      },
    });

    expect((await session.refresh('overview')).status).toBe('committed');
    expect((await session.refresh('overview')).status).toBe('no-change');
    expect((await session.refresh('sessions')).status).toBe('committed');
    expect(loads).toBe(2);
  });

  test('reacquires exactly once after expiry and preserves the previous commit on a second failure', async () => {
    let acquisitions = 0;
    const commits: string[] = [];
    const expired = new Error('expired');
    const session = createServedReportSession<string, string>({
      acquire: async () => descriptor(`r${++acquisitions}`),
      commit: (prepared) => commits.push(prepared),
      destinationFingerprint: (destination: string) => destination,
      isRevisionExpired: (error) => error === expired,
      load: (_destination, current) => {
        if (current.revision === 'r1') {
          return Promise.reject(expired);
        }
        return Promise.resolve(current.revision);
      },
    });
    expect((await session.refresh('overview')).status).toBe('committed');
    expect(acquisitions).toBe(2);
    expect(commits).toEqual(['r2']);

    const failing = createServedReportSession<string, string>({
      acquire: async () => descriptor('expired'),
      commit: () => commits.push('unexpected'),
      destinationFingerprint: (destination: string) => destination,
      isRevisionExpired: (error) => error === expired,
      load: () => Promise.reject(expired),
    });
    expect((await failing.refresh('overview')).status).toBe('failed-preserving-previous');
  });

  test('abort invalidates pending work without a late commit', async () => {
    const pending = deferred<string>();
    let commits = 0;
    const session = createServedReportSession<string, string>({
      acquire: () => Promise.resolve(descriptor('r1')),
      commit: () => {
        commits += 1;
      },
      destinationFingerprint: (destination: string) => destination,
      isRevisionExpired: () => false,
      load: () => pending.promise,
    });
    const result = session.refresh('sessions');
    session.abort();
    pending.resolve('prepared');
    expect((await result).status).toBe('superseded');
    expect(commits).toBe(0);
  });
});
