import type { HandleClientError } from '@sveltejs/kit/hooks';
import { clientErrorMessage } from '#lib/features/shell/report-render-error.ts';

// Replaces SvelteKit's default, which logs an unexpected exception and shows only "Internal Error".
export const handleError: HandleClientError = ({ error, kind }) => {
  if (kind !== 'unknown') {
    return;
  }
  console.error(error);
  return { message: clientErrorMessage(error) };
};
