import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeAiUsageWideEventResource, type WideEventSnapshot } from '@ai-usage/effect-runtime';
import { makeEngineWideEventSinkLayer } from '@ai-usage/effect-runtime/node';
import { createLocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { createLiveUsageEngineRuntime, createTerminalSourceControlPort } from '@ai-usage/usage-engine-runtime/live';
import { type ScheduledSource, SourceRunError } from '@ai-usage/usage-engine-runtime/source-adapters';
import { Duration, Effect } from 'effect';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('writes one private engine event per source run without operational secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-events-'));
  roots.push(root);
  const logDirectory = path.join(root, 'logs');
  const privateToken = 'private-bearer-token';
  const privatePath = '/private/operator/history/session.jsonl';
  const privateRowContent = 'private-session-row-content';
  const source: ScheduledSource = {
    cadence: Duration.hours(1),
    detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
    id: 'claude.sessions',
    run: () =>
      Effect.fail(
        new SourceRunError({
          cause: new Error(`${privateToken} ${privatePath} ${privateRowContent}`),
          message: 'The source fixture failed.',
          sourceId: 'claude.sessions',
        }),
      ),
  };
  const port = createTerminalSourceControlPort({
    instanceId: '55555555-5555-4555-8555-555555555555',
    policyStore: {
      load: Effect.succeed({ 'claude.sessions': { enabled: false } }),
      setEnabled: () => Effect.void,
    },
    publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
    sources: new Map([['claude.sessions', source]]),
    wideEventSinkLayer: makeEngineWideEventSinkLayer({
      directory: logDirectory,
      resource: {
        ...makeAiUsageWideEventResource({
          instanceId: '55555555-5555-4555-8555-555555555555',
          nodeEnvironment: 'test',
          surface: 'engine',
        }),
        surface: 'engine',
      },
      silenceConsole: true,
    }),
  });

  await port.start();
  await expect(port.setSourceEnabled('claude.sessions', true)).rejects.toThrow('completed with failed');
  await port.dispose();

  const eventFiles = (await readdir(logDirectory)).filter((name) => name.endsWith('.ndjson'));
  const eventLines = (await Promise.all(eventFiles.map((name) => readFile(path.join(logDirectory, name), 'utf8'))))
    .flatMap((body) => body.split('\n'))
    .filter(Boolean);
  const events = eventLines.map((line) => JSON.parse(line) as WideEventSnapshot);
  const sourceEvents = events.filter((event) => event.boundary === 'source.run');
  const serialized = eventLines.join('\n');

  expect(sourceEvents).toHaveLength(1);
  expect(sourceEvents[0]).toMatchObject({
    annotations: { failureKind: 'source-run-error', sourceId: 'claude.sessions', trigger: 'manual' },
    outcome: 'failure',
    resource: { surface: 'engine' },
  });
  expect(events.every((event) => event.resource.surface === 'engine')).toBe(true);
  expect(serialized).not.toContain(privateToken);
  expect(serialized).not.toContain(privatePath);
  expect(serialized).not.toContain(privateRowContent);
});

test('emits engine lifecycle and command boundaries from the production composition', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-lifecycle-events-'));
  roots.push(root);
  const logDirectory = path.join(root, 'logs');
  const inboxDirectory = path.join(root, 'state', 'inbox');
  const temporaryRoot = path.join(root, 'legacy-temp');
  await Promise.all([
    mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
    mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
  ]);
  const instanceId = '77777777-7777-4777-8777-777777777777';
  const wideEventSinkLayer = makeEngineWideEventSinkLayer({
    directory: logDirectory,
    resource: {
      ...makeAiUsageWideEventResource({ instanceId, nodeEnvironment: 'test', surface: 'engine' }),
      surface: 'engine',
    },
    silenceConsole: true,
  });
  const runtime = createLiveUsageEngineRuntime({
    acquireWriterLease: () => Promise.resolve({ release: () => Promise.resolve() }),
    configCwd: root,
    dbPath: path.join(root, 'state', 'usage.sqlite'),
    inboxDirectory,
    instanceId,
    operatorCwd: root,
    storage: createLocalHistoryStorage(path.join(root, 'home')),
    temporaryRoot,
    wideEventSinkLayer,
  });

  await runtime.start();
  const admitted = await runtime.executeCommand({ command: 'publish' }, 'observed-command');
  expect(admitted.ok).toBe(true);
  await expect(runtime.waitForCommand('observed-command')).resolves.toMatchObject({ state: 'succeeded' });
  await runtime.dispose();

  const eventFiles = (await readdir(logDirectory)).filter((name) => name.endsWith('.ndjson'));
  const eventLines = (await Promise.all(eventFiles.map((name) => readFile(path.join(logDirectory, name), 'utf8'))))
    .flatMap((body) => body.split('\n'))
    .filter(Boolean);
  const events = eventLines.map((line) => JSON.parse(line) as WideEventSnapshot);
  const boundaries = new Set(events.map((event) => event.boundary));

  expect(boundaries).toEqual(
    expect.objectContaining(new Set(['engine.command', 'migration', 'publication', 'retention'])),
  );
  expect(events.find((event) => event.boundary === 'engine.command')).toMatchObject({
    annotations: { command: 'publish' },
    outcome: 'success',
    resource: { surface: 'engine' },
  });
  expect(events.filter((event) => event.boundary === 'retention').length).toBeGreaterThanOrEqual(2);
  expect(eventLines.join('\n')).not.toContain(root);
});
