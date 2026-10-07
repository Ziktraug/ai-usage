import { expect, test } from 'bun:test';
import { executeAnalysesCommand, parseAnalysesCommand } from './analyses';

test('analyses CLI preserves exact project/revision/row selection and explicit permission', () => {
  expect(
    parseAnalysesCommand(['select', '--project', 'p', '--revision', 'r', '--row', 'a', '--row', 'b']),
  ).toMatchObject({
    kind: 'request',
    request: {
      kind: 'select',
      projectId: 'p',
      selections: [
        { revision: 'r', rowId: 'a' },
        { revision: 'r', rowId: 'b' },
      ],
    },
  });
  expect(() => parseAnalysesCommand(['prepare', '--project', 'p', '--revision', 'r', '--row', 'a'])).toThrow();
  expect(
    parseAnalysesCommand([
      'prepare',
      '--project',
      'p',
      '--revision',
      'r',
      '--row',
      'a',
      '--authorize-provider-processing',
    ]),
  ).toMatchObject({ request: { providerProcessingAuthorized: true, revisionKey: null, producerSessionId: null } });
  expect(() => parseAnalysesCommand(['get', '--project', 'p', '--id', 'a', '--path', '/private'])).toThrow();
});

test('bounded recall sends only an explicit corpus request, without inference or engine startup', async () => {
  const calls: unknown[] = [];
  const command = parseAnalysesCommand([
    'context',
    '--project',
    'p',
    '--query',
    'revision cache',
    '--max-bytes',
    '1024',
  ]);
  const result = await executeAnalysesCommand(command, {
    distillation: (request) => {
      calls.push(request);
      return Promise.resolve({ corpus: 'session-analyses', analyses: [], omitted: 1 });
    },
  });
  expect(calls).toEqual([{ kind: 'context', projectId: 'p', query: 'revision cache', maxBytes: 1024 }]);
  expect(JSON.parse(result).omitted).toBe(1);
  expect(new TextEncoder().encode(result).length).toBeLessThan(1024);
});

test('help is local, and budgets/unknown options are rejected before transport', async () => {
  const client = {
    distillation: () => Promise.reject(new Error('transport must not run')),
  };
  expect(await executeAnalysesCommand(parseAnalysesCommand(['--help']), client)).toContain(
    'active-provider processing',
  );
  expect(() => parseAnalysesCommand(['context', '--project', 'p', '--query', 'x', '--max-bytes', '999999'])).toThrow();
  expect(() => parseAnalysesCommand(['search', '--project', 'p', '--query', 'x', '--limit', '0'])).toThrow();
  expect(() => parseAnalysesCommand(['search', '--project', 'p', '--query', 'x', '--project', 'other'])).toThrow();
});

test('discovery starts from the current checkout and preserves exact preview subsets', () => {
  expect(parseAnalysesCommand(['discover'])).toMatchObject({
    request: {
      kind: 'discover',
      selector: { kind: 'checkout', value: process.cwd() },
      limit: 10,
      since: null,
      until: null,
    },
  });
  expect(
    parseAnalysesCommand([
      'discover',
      '--project',
      'Exact project name',
      '--since',
      '2026-10-01T00:00:00Z',
      '--limit',
      '2',
    ]),
  ).toMatchObject({
    request: {
      selector: { kind: 'project', value: 'Exact project name' },
      since: '2026-10-01T00:00:00.000Z',
      limit: 2,
    },
  });
  expect(
    parseAnalysesCommand([
      'prepare',
      '--selection',
      'opaque-preview',
      '--row',
      'chosen-row',
      '--authorize-provider-processing',
    ]),
  ).toMatchObject({
    request: {
      kind: 'prepare-selection',
      selectionToken: 'opaque-preview',
      chosenRowIds: ['chosen-row'],
      providerProcessingAuthorized: true,
    },
  });
  expect(() => parseAnalysesCommand(['discover', '--checkout', '.', '--project', 'name'])).toThrow(
    'ambiguous-cli-selector',
  );
  expect(() => parseAnalysesCommand(['discover', '--limit', '11'])).toThrow();
  expect(() => parseAnalysesCommand(['prepare', '--selection', 'opaque-preview'])).toThrow();
});

test('CLI exposes bounded task and literal retrieval, verified evidence, jobs, and explicit removal', () => {
  expect(
    parseAnalysesCommand(['search', '--project', 'p', '--query', 'How did we fix the cache?', '--mode', 'task']),
  ).toMatchObject({ request: { kind: 'search', mode: 'task' } });
  expect(
    parseAnalysesCommand(['evidence', '--project', 'p', '--id', 'a', '--event', 'e1', '--event', 'e2']),
  ).toMatchObject({ request: { kind: 'evidence', eventIds: ['e1', 'e2'] } });
  expect(() => parseAnalysesCommand(['evidence', '--project', 'p', '--id', 'a'])).toThrow('invalid-evidence-selection');
  expect(() =>
    parseAnalysesCommand(['evidence', '--project', 'p', '--id', 'a', '--event', 'e', '--event', 'e']),
  ).toThrow();
  expect(parseAnalysesCommand(['jobs', '--project', 'p'])).toMatchObject({
    request: { kind: 'jobs', projectId: 'p', limit: 50 },
  });
  expect(() => parseAnalysesCommand(['remove', '--project', 'p', '--id', 'a', '--mode', 'purge'])).toThrow();
  expect(
    parseAnalysesCommand([
      'remove',
      '--project',
      'p',
      '--id',
      'a',
      '--mode',
      'purge',
      '--confirm',
      '--preserve-knowledge',
    ]),
  ).toMatchObject({ request: { kind: 'remove', confirmed: true, preserveKnowledge: true } });
});
