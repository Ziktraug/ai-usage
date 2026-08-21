import { describe, expect, test } from 'bun:test';
import { parseUsageEngineCommandCompletion } from '@ai-usage/usage-engine-control';
import { setMachineLabelForServer } from './machine-label.server';

const completion = (label: string, command: 'publish' | 'set-machine-label' = 'set-machine-label') =>
  parseUsageEngineCommandCompletion(
    command === 'set-machine-label'
      ? {
          command,
          commandId: 'label-command',
          completedAt: '2026-07-30T12:00:00.000Z',
          output: { kind: 'machine', machine: { id: 'machine-a', label } },
          state: 'succeeded',
        }
      : {
          command,
          commandId: 'publish-command',
          completedAt: '2026-07-30T12:00:00.000Z',
          output: {
            kind: 'publication',
            publication: { publishedAt: '2026-07-30T12:00:00.000Z', revision: 'revision-1' },
          },
          state: 'succeeded',
        },
  );

const labelFixture = () => {
  const commands: { readonly command: string; readonly label: string }[] = [];
  const mutate = async (label: string) =>
    await setMachineLabelForServer({ label }, (command) => {
      commands.push({ command: command.command, label: command.label });
      return Promise.resolve(completion(command.label));
    });
  return { commands, mutate };
};

describe('machine label server boundary', () => {
  test('trims the label, issues one set-machine-label command, and echoes the engine identity', async () => {
    const { commands, mutate } = labelFixture();

    expect(await mutate('  Studio Mac  ')).toEqual({ machine: { id: 'machine-a', label: 'Studio Mac' } });
    expect(commands).toEqual([{ command: 'set-machine-label', label: 'Studio Mac' }]);
  });

  test('rejects a blank label and one past the engine byte bound before command admission', async () => {
    const { commands, mutate } = labelFixture();

    await expect(mutate('   ')).rejects.toThrow();
    // The engine bounds the label by UTF-8 bytes, so 121 two-byte characters is over the limit even
    // though it is well under any character count.
    await expect(mutate('é'.repeat(121))).rejects.toThrow();
    expect(commands).toEqual([]);
    await expect(mutate('é'.repeat(120))).resolves.toEqual({
      machine: { id: 'machine-a', label: 'é'.repeat(120) },
    });
  });

  test('refuses to report a rename the engine did not complete', async () => {
    // A completion for another command, or a non-succeeded one, must not read as an applied rename.
    await expect(
      setMachineLabelForServer({ label: 'Studio Mac' }, () => Promise.resolve(completion('Studio Mac', 'publish'))),
    ).rejects.toThrow('did not complete');
    await expect(
      setMachineLabelForServer({ label: 'Studio Mac' }, () =>
        Promise.resolve(
          parseUsageEngineCommandCompletion({
            command: 'set-machine-label',
            commandId: 'label-command',
            completedAt: '2026-07-30T12:00:00.000Z',
            error: { code: 'command-failed', message: 'The engine refused the rename.' },
            state: 'failed',
          }),
        ),
      ),
    ).rejects.toThrow('did not complete');
  });
});
