import { describe, expect, test } from 'bun:test';
import {
  parseUsageEngineCommandRequest,
  USAGE_ENGINE_PROTOCOL_VERSION,
  usageEngineControlBounds,
} from '@ai-usage/usage-engine-control';
import { parseUsageEngineProcessArguments } from './process-arguments';

const commandRequest = JSON.stringify({
  command: { command: 'publish' },
  commandId: 'command-1',
  protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
});

describe('usage engine process arguments', () => {
  test('parses serve, once, and check modes with canonical ports', () => {
    expect(parseUsageEngineProcessArguments(['serve'])).toEqual({ mode: 'serve', port: 0 });
    expect(parseUsageEngineProcessArguments(['serve', '--port', '0'])).toEqual({ mode: 'serve', port: 0 });
    expect(parseUsageEngineProcessArguments(['serve', '--port', '65535'])).toEqual({ mode: 'serve', port: 65_535 });
    expect(parseUsageEngineProcessArguments(['once', commandRequest])).toEqual({
      mode: 'once',
      request: JSON.parse(commandRequest),
    });
    expect(parseUsageEngineProcessArguments(['check'])).toEqual({ mode: 'check' });
  });

  test('accepts bounded operator-file commands in foreground mode', () => {
    const request = parseUsageEngineCommandRequest({
      command: {
        command: 'preview-merge',
        input: { filePath: '/operator/merge.json', kind: 'operator-file' },
      },
      commandId: 'preview-1',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });

    expect(parseUsageEngineProcessArguments(['once', JSON.stringify(request)])).toEqual({
      mode: 'once',
      request,
    });
  });

  test('rejects missing, unknown, trailing, malformed, noncanonical, and oversized arguments', () => {
    const invalidArguments = [
      [],
      ['unknown'],
      ['serve', '--port'],
      ['serve', '--port', '01'],
      ['serve', '--port', '-1'],
      ['serve', '--port', '65536'],
      ['serve', '--host', 'localhost'],
      ['serve', '--port', '41052', 'trailing'],
      ['once'],
      ['once', '{'],
      ['once', commandRequest, 'trailing'],
      ['check', 'trailing'],
    ];
    for (const args of invalidArguments) {
      expect(() => parseUsageEngineProcessArguments(args)).toThrow();
    }

    expect(() =>
      parseUsageEngineProcessArguments([
        'once',
        JSON.stringify({
          command: { command: 'publish' },
          commandId: 'command-1',
          padding: 'x'.repeat(usageEngineControlBounds.maxCommandBytes),
          protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
        }),
      ]),
    ).toThrow('byte limit');
  });
});
