import { expect, openHydratedReport, test } from './browser-test';

const fixture = '/src/lib/features/prompts/prompt-exploration.e2e-fixture.ts';

test('semantic preparation is optional and worker construction errors stay visible', async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error('Synthetic worker unavailable');
      }
    } as unknown as typeof Worker;
  });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: fixture });
  await expect(page.getByRole('button', { name: 'Analyze loaded prompts locally' })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare local model' }).click();
  await expect(
    page.getByText('This browser could not start the local analysis worker. No remote fallback is used.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analyze loaded prompts locally' })).toBeDisabled();
});

test('cancelling preparation terminates the worker before any prompts are sent', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, { semanticCalls: calls });
    window.Worker = class {
      postMessage(message: unknown) {
        calls.push(message);
      }
      terminate() {
        calls.push('terminated');
      }
    } as unknown as typeof Worker;
  });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: fixture });
  await page.getByRole('button', { name: 'Prepare local model' }).click();
  await page.getByRole('button', { name: 'Cancel local analysis' }).click();
  await expect(page.getByRole('button', { name: 'Analyze loaded prompts locally' })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, 'semanticCalls'))).toEqual([{ kind: 'prepare' }, 'terminated']);
});

test('invalid embeddings are rejected without silently substituting lexical groups', async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage(message: { kind: string }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: message.kind === 'prepare' ? { kind: 'ready' } : { kind: 'result', vectors: [[1]] },
          }),
        );
      }
      terminate() {
        // No background work exists in this deterministic worker double.
      }
    } as unknown as typeof Worker;
  });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: fixture });
  await page.getByRole('button', { name: 'Prepare local model' }).click();
  await page.getByRole('button', { name: 'Analyze loaded prompts locally' }).click();
  await expect(page.getByText('The embedding result was invalid. No lexical substitution was made.')).toBeVisible();
  await expect(page.getByLabel('Candidate family')).toHaveCount(0);
});
