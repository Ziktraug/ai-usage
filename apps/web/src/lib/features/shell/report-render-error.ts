/** Render exceptions are defects, not Query failures; always surface them to the host. */
export const reportRenderError = (cause: unknown): void => {
  if (typeof window !== 'undefined' && typeof globalThis.reportError === 'function') {
    globalThis.reportError(cause);
  } else {
    console.error('Region rendering failed', cause);
  }
};

export const recoverRegion = async (reset: () => void, refetch: () => Promise<void>): Promise<void> => {
  await refetch();
  reset();
};
