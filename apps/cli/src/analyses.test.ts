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
