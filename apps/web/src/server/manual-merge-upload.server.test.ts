import { describe, expect, test } from 'bun:test';
import { parseMergePreviewProof } from '@ai-usage/report-core/merge-proof';
import {
  parseUsageEngineCommandCompletion,
  parseUsageEngineHandoffId,
  type UsageEngineCommand,
  type UsageEngineCommandCompletion,
} from '@ai-usage/usage-engine-control';
import type { StagedUsageEngineHandoff } from '@ai-usage/usage-engine-control/handoff';
import { handleManualMergeUpload } from './manual-merge-upload.server';
import { UsageEngineCommandCompletionError } from './usage-engine-command.server';

const DIGEST = 'a'.repeat(64);
const CONFIRMATION_TOKEN = `v1.${'b'.repeat(64)}`;
const MERGE_PROOF = parseMergePreviewProof({ confirmationToken: CONFIRMATION_TOKEN, documentDigest: DIGEST });

const jsonRequest = (body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  new Request('http://localhost/sync', {
    body,
    headers: {
      'content-type': 'application/json',
      host: 'localhost',
      origin: 'http://localhost',
      'x-ai-usage-merge-action': 'preview',
      ...headers,
    },
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });

const previewCompletion = (): UsageEngineCommandCompletion =>
  parseUsageEngineCommandCompletion({
    command: 'preview-merge',
    commandId: 'preview-command',
    completedAt: '2026-07-30T12:00:00.000Z',
    output: {
      bundle: { generatedAt: '2026-07-30T12:00:00.000Z', machineId: 'machine-b', machineLabel: 'Peer MacBook' },
      bytes: 11,
      confirmationToken: CONFIRMATION_TOKEN,
      documentDigest: DIGEST,
      kind: 'merge-preview',
      result: {
        deleted: 0,
        fleetChanged: false,
        inserted: 0,
        superseded: 0,
        unchanged: 0,
        updated: 0,
        warnings: 0,
      },
      rows: 0,
      warningCount: 0,
      warningItems: [],
    },
    state: 'succeeded',
  });

const confirmedCompletion = (): UsageEngineCommandCompletion =>
  parseUsageEngineCommandCompletion({
    command: 'confirm-merge',
    commandId: 'confirm-command',
    completedAt: '2026-07-30T12:00:00.000Z',
    output: { kind: 'none' },
    state: 'succeeded',
  });

const cursorCompletion = (alreadyImported: boolean): UsageEngineCommandCompletion =>
  parseUsageEngineCommandCompletion({
    command: 'import-cursor',
    commandId: 'cursor-command',
    completedAt: '2026-07-30T12:00:00.000Z',
    output: { alreadyImported, artifactName: 'abc123-usage-events.csv', kind: 'cursor-import' },
    state: 'succeeded',
  });

const csvRequest = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/sync', {
    body,
    headers: {
      'content-type': 'text/csv',
      host: 'localhost',
      origin: 'http://localhost',
      'x-ai-usage-merge-action': 'cursor',
      ...headers,
    },
    method: 'POST',
  });

const stagedFixture = (handoffId: string, onCleanup: () => void): StagedUsageEngineHandoff => ({
  cleanup: () => {
    onCleanup();
    return Promise.resolve();
  },
  input: { handoffId: parseUsageEngineHandoffId(handoffId), kind: 'inbox-handoff' },
});

describe('manual merge upload boundary', () => {
  test('stages exact preview bytes, awaits the exact engine command, and cleans up', async () => {
    const stagedBytes: Uint8Array[] = [];
    const commands: UsageEngineCommand[] = [];
    let cleanups = 0;
    const response = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
      executeCommand: (command) => {
        commands.push(command);
        return Promise.resolve(previewCompletion());
      },
      stageHandoff: (bytes) => {
        stagedBytes.push(bytes);
        return Promise.resolve(stagedFixture('preview-handoff', () => (cleanups += 1)));
      },
    });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(stagedBytes[0])).toBe('{"rows":[]}');
    expect(commands).toEqual([
      {
        command: 'preview-merge',
        input: { handoffId: parseUsageEngineHandoffId('preview-handoff'), kind: 'inbox-handoff' },
      },
    ]);
    expect(cleanups).toBe(1);
    expect(await response.json()).toMatchObject({ data: { kind: 'merge-preview' }, ok: true });
  });

  test('routes the cursor action to import-cursor and reports the staged artifact', async () => {
    const commands: UsageEngineCommand[] = [];
    let cleanups = 0;
    const response = await handleManualMergeUpload(csvRequest('Date,Model\n2026-07-30,gpt-5\n'), {
      executeCommand: (command) => {
        commands.push(command);
        return Promise.resolve(cursorCompletion(false));
      },
      stageHandoff: () => Promise.resolve(stagedFixture('cursor-handoff', () => (cleanups += 1))),
    });

    expect(response.status).toBe(200);
    expect(commands).toEqual([
      {
        command: 'import-cursor',
        input: { handoffId: parseUsageEngineHandoffId('cursor-handoff'), kind: 'inbox-handoff' },
      },
    ]);
    expect(cleanups).toBe(1);
    expect(await response.json()).toEqual({
      data: { alreadyImported: false, artifactName: 'abc123-usage-events.csv', kind: 'cursor-import' },
      ok: true,
    });

    const repeated = await handleManualMergeUpload(csvRequest('Date,Model\n2026-07-30,gpt-5\n'), {
      executeCommand: () => Promise.resolve(cursorCompletion(true)),
      stageHandoff: () => Promise.resolve(stagedFixture('cursor-handoff-2', () => undefined)),
    });
    expect(await repeated.json()).toMatchObject({ data: { alreadyImported: true }, ok: true });
  });

  test('keeps each action on its own media type and rejects mismatched completions', async () => {
    const options = {
      executeCommand: () => Promise.resolve(previewCompletion()),
      stageHandoff: () => Promise.resolve(stagedFixture('unused-handoff', () => undefined)),
    };
    // A CSV body must not reach preview-merge, and a merge bundle must not reach import-cursor.
    const csvAsPreview = await handleManualMergeUpload(
      csvRequest('Date,Model\n', { 'x-ai-usage-merge-action': 'preview' }),
      options,
    );
    const jsonAsCursor = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', { 'x-ai-usage-merge-action': 'cursor' }),
      options,
    );
    // The cursor action asks for import-cursor; a preview completion is not an acceptable answer.
    const mismatched = await handleManualMergeUpload(csvRequest('Date,Model\n'), options);

    expect(csvAsPreview.status).toBe(415);
    expect(jsonAsCursor.status).toBe(415);
    expect(mismatched.status).toBe(502);
  });

  test('describes Cursor failures as Cursor failures rather than as merge failures', async () => {
    const options = {
      executeCommand: () =>
        Promise.reject(new UsageEngineCommandCompletionError('command-failed', 'private engine detail')),
      stageHandoff: () => Promise.resolve(stagedFixture('cursor-handoff', () => undefined)),
    };
    const empty = await handleManualMergeUpload(csvRequest(''), options);
    const invalidUtf8 = await handleManualMergeUpload(csvRequest(new Uint8Array([0xc3, 0x28])), options);
    const engineFailure = await handleManualMergeUpload(csvRequest('Date,Model\n'), options);

    // The client renders these messages verbatim, so a bad CSV must not be told to fix its JSON.
    const emptyText = JSON.stringify(await empty.json());
    expect(emptyText).toContain('Cursor usage export');
    expect(emptyText).not.toContain('usage merge file');
    const invalidUtf8Text = JSON.stringify(await invalidUtf8.json());
    expect(invalidUtf8Text).toContain('UTF-8 CSV');
    expect(invalidUtf8Text).not.toContain('UTF-8 JSON');
    const engineText = JSON.stringify(await engineFailure.json());
    expect(engineText).toContain('Cursor import');
    expect(engineText).not.toContain('this merge');
    expect(engineText).not.toContain('private engine detail');

    // The merge path keeps its own wording.
    const mergeFailure = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), options);
    const mergeText = JSON.stringify(await mergeFailure.json());
    expect(mergeText).toContain('this merge');
    expect(mergeText).not.toContain('Cursor');
  });

  test('transports bounded confirmation preconditions with a newly staged handoff', async () => {
    const commands: UsageEngineCommand[] = [];
    const response = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', {
        'x-ai-usage-merge-action': 'confirm',
        'x-ai-usage-merge-confirmation': CONFIRMATION_TOKEN,
        'x-ai-usage-merge-digest': DIGEST,
      }),
      {
        executeCommand: (command) => {
          commands.push(command);
          return Promise.resolve(confirmedCompletion());
        },
        stageHandoff: () => Promise.resolve(stagedFixture('confirm-handoff', () => undefined)),
      },
    );

    expect(response.status).toBe(200);
    expect(commands).toEqual([
      {
        ...MERGE_PROOF,
        command: 'confirm-merge',
        input: { handoffId: parseUsageEngineHandoffId('confirm-handoff'), kind: 'inbox-handoff' },
      },
    ]);
    expect(await response.json()).toEqual({ data: { kind: 'none' }, ok: true });
  });

  test('rejects trust and media-type failures before staging bytes', async () => {
    let stages = 0;
    const options = {
      executeCommand: () => Promise.resolve(previewCompletion()),
      stageHandoff: () => {
        stages += 1;
        return Promise.resolve(stagedFixture('unused-handoff', () => undefined));
      },
    };
    const crossOrigin = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', { origin: 'http://attacker.example' }),
      options,
    );
    const wrongContentType = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', { 'content-type': 'text/plain' }),
      options,
    );
    const rebound = await handleManualMergeUpload(
      jsonRequest('{"rows":[]}', { host: 'attacker.example', origin: 'http://attacker.example' }),
      options,
    );

    expect(crossOrigin.status).toBe(403);
    expect(wrongContentType.status).toBe(415);
    expect(rebound.status).toBe(403);
    expect(stages).toBe(0);
  });

  test('requires an explicit action, strict UTF-8, bounded bytes, and valid confirmation headers', async () => {
    const options = {
      executeCommand: () => Promise.resolve(previewCompletion()),
      maxBytes: 4,
      stageHandoff: () => Promise.resolve(stagedFixture('unused-handoff', () => undefined)),
    };
    const implicitImport = await handleManualMergeUpload(
      jsonRequest('{}', { 'x-ai-usage-merge-action': 'import' }),
      options,
    );
    const tooLarge = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), options);
    const invalidUtf8 = await handleManualMergeUpload(jsonRequest(new Uint8Array([0xc3, 0x28])), {
      ...options,
      maxBytes: 4,
    });
    const invalidConfirmation = await handleManualMergeUpload(
      jsonRequest('{}', {
        'x-ai-usage-merge-action': 'confirm',
        'x-ai-usage-merge-confirmation': 'token',
        'x-ai-usage-merge-digest': 'not-a-digest',
      }),
      { ...options, maxBytes: 4 },
    );

    expect(implicitImport.status).toBe(400);
    expect(tooLarge.status).toBe(413);
    expect(invalidUtf8.status).toBe(400);
    expect(invalidConfirmation.status).toBe(400);
  });

  test('cancels a blocked upload body on request abort before staging', async () => {
    const abort = new AbortController();
    let bodyCancels = 0;
    let stages = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancels += 1;
      },
      pull: () => new Promise<void>(() => undefined),
    });
    const responsePromise = handleManualMergeUpload(jsonRequest(body, {}, abort.signal), {
      executeCommand: () => Promise.resolve(previewCompletion()),
      stageHandoff: () => {
        stages += 1;
        return Promise.resolve(stagedFixture('unused-handoff', () => undefined));
      },
    });
    await Promise.resolve();

    abort.abort();
    const response = await responsePromise;

    expect(response.status).toBe(499);
    expect(bodyCancels).toBe(1);
    expect(stages).toBe(0);
  });

  test('returns promptly on abort during staging and cleans a handoff that settles late', async () => {
    const abort = new AbortController();
    let cleanupCount = 0;
    let resolveStaging: ((staged: StagedUsageEngineHandoff) => void) | undefined;
    let resolveStagingStarted: (() => void) | undefined;
    let stagingSignal: AbortSignal | undefined;
    const staging = new Promise<StagedUsageEngineHandoff>((resolve) => {
      resolveStaging = resolve;
    });
    const stagingStarted = new Promise<void>((resolve) => {
      resolveStagingStarted = resolve;
    });
    const responsePromise = handleManualMergeUpload(jsonRequest('{"rows":[]}', {}, abort.signal), {
      executeCommand: () => Promise.resolve(previewCompletion()),
      stageHandoff: (_bytes, signal) => {
        stagingSignal = signal;
        resolveStagingStarted?.();
        return staging;
      },
    });
    await stagingStarted;

    abort.abort();
    const response = await responsePromise;
    resolveStaging?.(stagedFixture('late-handoff', () => (cleanupCount += 1)));
    await staging;
    await Promise.resolve();

    expect(response.status).toBe(499);
    expect(stagingSignal?.aborted).toBe(true);
    expect(cleanupCount).toBe(1);
  });

  test('maps stable engine failures and cleans the handoff after rejection', async () => {
    const cases = [
      ['merge-invalid-json', 400],
      ['merge-invalid-input', 422],
      ['preview-stale', 409],
      ['merge-self-merge', 409],
      ['protocol-mismatch', 409],
      ['request-too-large', 413],
      ['invalid-response', 502],
      ['engine-unavailable', 503],
      ['timeout', 503],
      ['merge-store-failed', 500],
    ] as const;

    for (const [code, expectedStatus] of cases) {
      let cleanups = 0;
      const response = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
        executeCommand: () => Promise.reject(new UsageEngineCommandCompletionError(code, `private ${code}`)),
        stageHandoff: () => Promise.resolve(stagedFixture(`${code}-handoff`, () => (cleanups += 1))),
      });
      expect(response.status).toBe(expectedStatus);
      expect(cleanups).toBe(1);
      expect(await response.json()).toMatchObject({
        error: { reason: code, tag: 'UsageEngineCommandError' },
        ok: false,
      });
    }
  });

  test('rejects mismatched completion output and reports cleanup failure without leaking paths', async () => {
    const mismatch = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
      executeCommand: () => Promise.resolve(confirmedCompletion()),
      stageHandoff: () => Promise.resolve(stagedFixture('mismatch-handoff', () => undefined)),
    });
    const cleanupFailure = await handleManualMergeUpload(jsonRequest('{"rows":[]}'), {
      executeCommand: () => Promise.resolve(previewCompletion()),
      stageHandoff: () =>
        Promise.resolve({
          cleanup: () => Promise.reject(new Error('/private/inbox/handoff.upload')),
          input: { handoffId: parseUsageEngineHandoffId('cleanup-handoff'), kind: 'inbox-handoff' },
        }),
    });

    expect(mismatch.status).toBe(502);
    expect(await mismatch.json()).toMatchObject({ error: { reason: 'invalid-response' }, ok: false });
    expect(cleanupFailure.status).toBe(500);
    expect(JSON.stringify(await cleanupFailure.json())).not.toContain('/private/inbox');
  });
});
