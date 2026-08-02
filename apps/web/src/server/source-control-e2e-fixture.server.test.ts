import { expect, test } from 'bun:test';
import { getSourceControlE2EClient } from './e2e/source-control-fixture.server';

test('models source commands through the in-memory usage engine control contract', async () => {
  const control = getSourceControlE2EClient();
  const initial = await control.getStatus();
  const initialRevision = initial.currentPublication?.revision;

  await control.execute({ command: 'run-source', sourceId: 'codex.sessions' });
  expect(await control.getStatus()).toMatchObject({
    sourceControl: {
      runningCount: 1,
      sources: expect.arrayContaining([
        expect.objectContaining({ id: 'codex.sessions', lifecycle: 'running', policy: 'enabled' }),
      ]),
    },
  });

  await control.execute({ command: 'set-source-enabled', enabled: false, sourceId: 'codex.sessions' });
  expect(await control.getStatus()).toMatchObject({
    sourceControl: {
      sources: expect.arrayContaining([
        expect.objectContaining({ id: 'codex.sessions', lifecycle: 'pausing', policy: 'disabled' }),
      ]),
    },
  });

  await Bun.sleep(300);

  const settled = await control.getStatus();
  expect(settled.currentPublication?.revision).not.toBe(initialRevision);
  expect(settled.sourceControl).toMatchObject({
    runningCount: 0,
    sources: expect.arrayContaining([
      expect.objectContaining({ id: 'codex.sessions', lifecycle: 'dormant', policy: 'disabled' }),
    ]),
  });
});
