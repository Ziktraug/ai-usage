import {
  test as base,
  type ConsoleMessage,
  type Locator,
  type Page,
  expect as playwrightExpect,
  type Request,
  type Response,
} from '@playwright/test';
import { isExpectedSkillsSaveFailureResponse, RPC_PATH_PREFIX } from './rpc-test-transport';

const CRITICAL_RESOURCE_TYPES = new Set(['document', 'fetch', 'xhr']);
const SOURCE_CONTROL_EVENTS_PATH = '/api/source-control';
const SOURCE_CONTROL_COMMAND_PATH = '/api/source-control/command';
const INTENTIONAL_EVENT_SOURCE_ABORT = 'net::ERR_ABORTED';
const REPORT_REQUEST_OWNER_HEADER = 'x-ai-usage-request-owner';
const INTENTIONAL_REPORT_REQUEST_OWNERS = new Set(['focused-report', 'session-query']);
const ROOT_ROUTE_MATCH_WARNING = 'Warning: Error in route match: __root__';
const EXPECTED_SHELL_ERROR_HEADER = 'x-ai-usage-expected-error';
const EXPECTED_SHELL_ERROR_VALUES = new Set(['not-found-fixture', 'shell-route']);

const requestPath = (request: Request): string => new URL(request.url()).pathname;

const isCriticalRequest = (request: Request): boolean => {
  if (CRITICAL_RESOURCE_TYPES.has(request.resourceType())) {
    return true;
  }
  const pathname = requestPath(request);
  return (
    pathname.startsWith(RPC_PATH_PREFIX) ||
    pathname === SOURCE_CONTROL_EVENTS_PATH ||
    pathname === SOURCE_CONTROL_COMMAND_PATH
  );
};

const isIntentionalSourceControlCancellation = (request: Request, errorText: string): boolean =>
  request.resourceType() === 'eventsource' &&
  requestPath(request) === SOURCE_CONTROL_EVENTS_PATH &&
  errorText === INTENTIONAL_EVENT_SOURCE_ABORT;

const isIntentionalReportRequestCancellation = (request: Request, errorText: string): boolean =>
  (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') &&
  requestPath(request).startsWith(RPC_PATH_PREFIX) &&
  INTENTIONAL_REPORT_REQUEST_OWNERS.has(request.headers()[REPORT_REQUEST_OWNER_HEADER] ?? '') &&
  errorText === INTENTIONAL_EVENT_SOURCE_ABORT;

interface PageListeners {
  console: (message: ConsoleMessage) => void;
  finalize: () => void;
  pageError: (error: Error) => void;
  requestFailed: (request: Request) => void;
  response: (response: Response) => void;
}

export const reportViewsFor = (page: Page): Locator => page.getByRole('navigation', { name: 'Report views' });

export const waitForHydratedReport = async (page: Page): Promise<void> => {
  await playwrightExpect(page.locator('main[data-hydrated="true"][data-route-shell="report"]')).toBeVisible();
};

export const openHydratedReport = async (page: Page, url = '/'): Promise<Awaited<ReturnType<Page['goto']>>> => {
  const response = await page.goto(url);
  await waitForHydratedReport(page);
  return response;
};

export const waitForFocusedReportSettled = async (page: Page): Promise<void> => {
  await waitForHydratedReport(page);
  await playwrightExpect(page.locator('[data-report-refresh-pending]')).toHaveCount(0);
  await playwrightExpect(page.locator('[data-report-complete-output]')).toBeVisible();
};

export const waitForHydratedSkills = async (page: Page): Promise<void> => {
  await playwrightExpect(page.locator('[data-skills-workspace][data-skills-hydrated="true"]')).toBeVisible();
};

export const openHydratedSkills = async (page: Page, url: string): Promise<Awaited<ReturnType<Page['goto']>>> => {
  const response = await page.goto(url);
  await waitForHydratedSkills(page);
  return response;
};

export const test = base.extend<{ browserFailureGate: undefined }>({
  browserFailureGate: [
    async ({ context }, use) => {
      const failures: string[] = [];
      const listenersByPage = new Map<Page, PageListeners>();

      const attach = (page: Page): void => {
        if (listenersByPage.has(page)) {
          return;
        }
        const expectedShellErrorUrls = new Set<string>();
        const pendingResourceErrors: Array<{
          readonly message: string;
          readonly source: string;
          readonly url: string;
        }> = [];
        const listeners: PageListeners = {
          console: (message) => {
            const messageType = message.type();
            const isRouteMatchWarning = messageType === 'warning' && message.text() === ROOT_ROUTE_MATCH_WARNING;
            const location = message.location();
            const isExpectedShellResourceError =
              messageType === 'error' &&
              message.text().startsWith('Failed to load resource: the server responded with a status of') &&
              expectedShellErrorUrls.has(location.url);
            if ((messageType !== 'error' && !isRouteMatchWarning) || isExpectedShellResourceError) {
              return;
            }
            const source = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';
            if (
              messageType === 'error' &&
              message.text().startsWith('Failed to load resource: the server responded with a status of')
            ) {
              pendingResourceErrors.push({ message: message.text(), source, url: location.url });
              return;
            }
            failures.push(`console ${messageType}${source}: ${message.text()}`);
          },
          finalize: () => {
            for (const error of pendingResourceErrors) {
              if (!expectedShellErrorUrls.has(error.url)) {
                failures.push(`console error${error.source}: ${error.message}`);
              }
            }
          },
          pageError: (error) => failures.push(`uncaught page error: ${error.stack ?? error.message}`),
          requestFailed: (request) => {
            if (!isCriticalRequest(request)) {
              return;
            }
            const errorText = request.failure()?.errorText ?? 'unknown transport failure';
            if (
              isIntentionalSourceControlCancellation(request, errorText) ||
              isIntentionalReportRequestCancellation(request, errorText)
            ) {
              return;
            }
            failures.push(`${request.resourceType()} request failed for ${requestPath(request)}: ${errorText}`);
          },
          response: (response) => {
            if (response.status() < 400 || !isCriticalRequest(response.request())) {
              return;
            }
            if (EXPECTED_SHELL_ERROR_VALUES.has(response.headers()[EXPECTED_SHELL_ERROR_HEADER] ?? '')) {
              expectedShellErrorUrls.add(response.url());
              return;
            }
            if (
              isExpectedSkillsSaveFailureResponse({
                headers: response.headers(),
                pathname: requestPath(response.request()),
                status: response.status(),
              })
            ) {
              expectedShellErrorUrls.add(response.url());
              return;
            }
            failures.push(
              `${response.request().resourceType()} request returned ${response.status()} for ${requestPath(response.request())}`,
            );
          },
        };
        listenersByPage.set(page, listeners);
        page.on('console', listeners.console);
        page.on('pageerror', listeners.pageError);
        page.on('requestfailed', listeners.requestFailed);
        page.on('response', listeners.response);
      };

      for (const page of context.pages()) {
        attach(page);
      }
      context.on('page', attach);

      await use(undefined);

      context.off('page', attach);
      for (const [page, listeners] of listenersByPage) {
        listeners.finalize();
        page.off('console', listeners.console);
        page.off('pageerror', listeners.pageError);
        page.off('requestfailed', listeners.requestFailed);
        page.off('response', listeners.response);
      }

      playwrightExpect(failures, `Unexpected browser failures:\n${failures.join('\n')}`).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
