import {
  test as base,
  type ConsoleMessage,
  type Page,
  expect as playwrightExpect,
  type Request,
  type Response,
} from '@playwright/test';

const CRITICAL_RESOURCE_TYPES = new Set(['document', 'fetch', 'xhr']);
const SOURCE_CONTROL_EVENTS_PATH = '/api/source-control';
const SOURCE_CONTROL_COMMAND_PATH = '/api/source-control/command';
const SERVER_FUNCTION_PATH_PREFIX = '/_serverFn/';
const INTENTIONAL_EVENT_SOURCE_ABORT = 'net::ERR_ABORTED';

const requestPath = (request: Request): string => new URL(request.url()).pathname;

const isCriticalRequest = (request: Request): boolean => {
  if (CRITICAL_RESOURCE_TYPES.has(request.resourceType())) {
    return true;
  }
  const pathname = requestPath(request);
  return (
    pathname.startsWith(SERVER_FUNCTION_PATH_PREFIX) ||
    pathname === SOURCE_CONTROL_EVENTS_PATH ||
    pathname === SOURCE_CONTROL_COMMAND_PATH
  );
};

const isIntentionalSourceControlCancellation = (request: Request, errorText: string): boolean =>
  request.resourceType() === 'eventsource' &&
  requestPath(request) === SOURCE_CONTROL_EVENTS_PATH &&
  errorText === INTENTIONAL_EVENT_SOURCE_ABORT;

interface PageListeners {
  console: (message: ConsoleMessage) => void;
  pageError: (error: Error) => void;
  requestFailed: (request: Request) => void;
  response: (response: Response) => void;
}

export const test = base.extend<{ browserFailureGate: undefined }>({
  browserFailureGate: [
    async ({ context }, use) => {
      const failures: string[] = [];
      const listenersByPage = new Map<Page, PageListeners>();

      const attach = (page: Page): void => {
        if (listenersByPage.has(page)) {
          return;
        }
        const listeners: PageListeners = {
          console: (message) => {
            if (message.type() !== 'error') {
              return;
            }
            const location = message.location();
            const source = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';
            failures.push(`console error${source}: ${message.text()}`);
          },
          pageError: (error) => failures.push(`uncaught page error: ${error.message}`),
          requestFailed: (request) => {
            if (!isCriticalRequest(request)) {
              return;
            }
            const errorText = request.failure()?.errorText ?? 'unknown transport failure';
            if (isIntentionalSourceControlCancellation(request, errorText)) {
              return;
            }
            failures.push(`${request.resourceType()} request failed for ${requestPath(request)}: ${errorText}`);
          },
          response: (response) => {
            if (response.status() < 400 || !isCriticalRequest(response.request())) {
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

      await use();

      context.off('page', attach);
      for (const [page, listeners] of listenersByPage) {
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
