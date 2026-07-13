import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/solid-start';
import { validateTrustedLocalRequest } from './server/local-request-trust.server';

const trustedLocalRequestMiddleware = createMiddleware().server(({ next, request }) => {
  const failure = validateTrustedLocalRequest(request);
  return failure ?? next();
});

const serverFunctionCsrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === 'serverFn',
});

export const startInstance = createStart(() => ({
  requestMiddleware: [trustedLocalRequestMiddleware, serverFunctionCsrfMiddleware],
}));
