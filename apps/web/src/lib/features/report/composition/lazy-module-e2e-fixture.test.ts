import { expect, test } from 'bun:test';
import { importReportLazyModule, REPORT_LAZY_MODULE_E2E_FAILURE_KEY } from './lazy-module-e2e-fixture';

test('injects one named E2E module failure without weakening later imports', async () => {
  Reflect.set(globalThis, REPORT_LAZY_MODULE_E2E_FAILURE_KEY, 'breakdown');
  let attempts = 0;
  const importModule = (): Promise<{ readonly name: string }> => {
    attempts += 1;
    return Promise.resolve({ name: 'Analysis' });
  };

  await expect(importReportLazyModule({ enabled: true, importModule, target: 'breakdown' })).rejects.toThrow(
    'Expected breakdown module failure',
  );
  expect(await importReportLazyModule({ enabled: true, importModule, target: 'breakdown' })).toEqual({
    name: 'Analysis',
  });
  expect(attempts).toBe(1);
});

test('ignores the E2E failure seam outside E2E mode', async () => {
  Reflect.set(globalThis, REPORT_LAZY_MODULE_E2E_FAILURE_KEY, 'sessions');

  expect(
    await importReportLazyModule({
      enabled: false,
      importModule: () => Promise.resolve({ name: 'Sessions' }),
      target: 'sessions',
    }),
  ).toEqual({ name: 'Sessions' });
  Reflect.deleteProperty(globalThis, REPORT_LAZY_MODULE_E2E_FAILURE_KEY);
});
