import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { createDemoEnvironment, DEMO_HOST, DEMO_PORT, parseDemoRunMode } from './run-web-demo';

describe('web demo launcher', () => {
  test('uses a fixed loopback listener and an isolated child environment', () => {
    const temporaryHome = '/tmp/ai-usage-demo-test';
    const environment = createDemoEnvironment(temporaryHome, '/synthetic/bin');

    expect({ host: DEMO_HOST, port: DEMO_PORT }).toEqual({ host: '127.0.0.1', port: 4176 });
    expect(environment).toEqual({
      AI_USAGE_ROOT_DIR: temporaryHome,
      AI_USAGE_SVELTEKIT_PHASE: 'dev',
      BROWSER: 'none',
      HOME: temporaryHome,
      NO_COLOR: '1',
      PATH: '/synthetic/bin',
      TMPDIR: path.join(temporaryHome, 'tmp'),
      TZ: 'Europe/Paris',
      VITE_AI_USAGE_DEMO: '1',
      VITE_AI_USAGE_E2E: '0',
      XDG_CACHE_HOME: path.join(temporaryHome, '.cache'),
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      XDG_DATA_HOME: path.join(temporaryHome, '.local', 'share'),
    });
    expect(environment.VITE_OPERATOR_SECRET).toBeUndefined();
    expect(environment.AI_USAGE_DATABASE_PATH).toBeUndefined();
    expect(environment.AI_USAGE_ENGINE_INSTANCE_ID).toBeUndefined();
    expect(environment.AI_USAGE_ENGINE_STATE_DIR).toBeUndefined();
    expect(environment.AI_USAGE_TEMP_ROOT).toBeUndefined();
  });

  test('splits finite preparation from the supervised demo server', () => {
    expect(parseDemoRunMode([])).toBe('prepare-and-serve');
    expect(parseDemoRunMode(['--prepare-only'])).toBe('prepare-only');
    expect(parseDemoRunMode(['--serve-only'])).toBe('serve-only');
    expect(() => parseDemoRunMode(['--prepare-only', '--serve-only'])).toThrow(
      'Usage: run-web-demo.ts [--prepare-only|--serve-only]',
    );
  });
});
