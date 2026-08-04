import type { Handle } from '@sveltejs/kit';
import { validateTrustedLocalRequest } from './local-request-trust.server';

export const handleTrustedLocalRequest: Handle = async ({ event, resolve }) => {
  if (!event.isSubRequest) {
    const trustFailure = validateTrustedLocalRequest(event.request);
    if (trustFailure) {
      return trustFailure;
    }
  }
  return await resolve(event);
};
