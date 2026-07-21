import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/solid-start';
import { rejectProtectedDemoRequest } from './server/demo-boundary.server';
import { validateTrustedLocalRequest } from './server/local-request-trust.server';

const demoBoundaryMiddleware = createMiddleware().server(
  ({ next, request }) => rejectProtectedDemoRequest(request) ?? next(),
);

const trustedLocalRequestMiddleware = createMiddleware().server(({ next, request }) => {
  const failure = validateTrustedLocalRequest(request);
  return failure ?? next();
});

const serverFunctionCsrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === 'serverFn',
});

export const startInstance = createStart(() => ({
  requestMiddleware: [demoBoundaryMiddleware, trustedLocalRequestMiddleware, serverFunctionCsrfMiddleware],
}));
