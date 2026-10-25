import { expect, test, waitForHydratedNavigation } from './browser-test';
import { MANUAL_MERGE_DOWNLOAD_PATH } from './rpc-test-transport';

/**
 * The production listener's origin is `http://127.0.0.1:<PORT>`, and SvelteKit 3 checks the Origin
 * of every mutation that declares no content type, or a form one, against it. A reader can still
 * open the app at `localhost`, which the trusted-local hook accepts; every mutation the browser
 * sends from there must therefore declare a non-form content type, as the bodyless manual export
 * does since SvelteKit 3.
 */
const LOCALHOST_BASE_URL = 'http://localhost:4177';
const EXPORT_FILENAME_PATTERN = /^ai-usage-.+\.json$/;
const SVELTEKIT_FORM_CSRF_REJECTION = 'Cross-site POST form submissions are forbidden';

test('exports the current machine from a tab opened at localhost', async ({ page, request }) => {
  // Control: without a declared content type SvelteKit refuses this origin, so the browser export
  // below passes only because it declares one.
  const undeclared = await request.post(`${LOCALHOST_BASE_URL}${MANUAL_MERGE_DOWNLOAD_PATH}`, {
    headers: { origin: LOCALHOST_BASE_URL },
  });
  expect(undeclared.status()).toBe(403);
  expect(await undeclared.text()).toBe(SVELTEKIT_FORM_CSRF_REJECTION);

  await page.goto(`${LOCALHOST_BASE_URL}/sync`);
  await waitForHydratedNavigation(page);
  const exportResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === MANUAL_MERGE_DOWNLOAD_PATH,
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current machine', exact: true }).click();

  const response = await exportResponse;
  expect(response.request().headers()['content-type']).toBe('application/json');
  expect(response.status()).toBe(200);
  expect((await download).suggestedFilename()).toMatch(EXPORT_FILENAME_PATTERN);
  await expect(page.getByRole('status').filter({ hasText: 'Exported ai-usage-' })).toBeVisible();
});
