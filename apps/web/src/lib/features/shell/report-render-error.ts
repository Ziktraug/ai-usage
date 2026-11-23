/** Render exceptions are defects, not Query failures; always surface them to the host. */
export const reportRenderError = (cause: unknown): void => {
  if (typeof window !== 'undefined' && typeof globalThis.reportError === 'function') {
    globalThis.reportError(cause);
  } else {
    console.error('Region rendering failed', cause);
  }
};

const MAX_ERROR_DETAIL_CHARACTERS = 300;
// SvelteKit's message for an unexpected exception, which it keeps back from the page.
const UNEXPECTED_ERROR_MESSAGE = 'Internal Error';

/** An unexpected browser exception is already in the browser: the error route may name it. */
export const clientErrorMessage = (cause: unknown): string => {
  const detail = (cause instanceof Error ? cause.message : String(cause)).trim();
  return `This page failed in the browser: ${detail.slice(0, MAX_ERROR_DETAIL_CHARACTERS) || 'no message'}`;
};

/** The error route's sentence: the error's own message, or where the cause SvelteKit kept back is. */
export const routeErrorMessage = (status: number, error: { readonly message: string } | null): string =>
  error === null || error.message.length === 0 || error.message === UNEXPECTED_ERROR_MESSAGE
    ? `The server failed to build this page (HTTP ${status}); its output names the cause.`
    : error.message;

export const recoverRegion = async (reset: () => void, refetch: () => Promise<void>): Promise<void> => {
  await refetch();
  reset();
};
