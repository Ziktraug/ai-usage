export interface ControlExplicitHttpDependencies {
  readonly handleCommand: (request: Request) => Promise<Response>;
  readonly handleEvents: (request: Request) => Promise<Response> | Response;
}

export interface ControlExplicitHttpAdapters {
  readonly sourceControlCommand: (request: Request) => Promise<Response>;
  readonly sourceControlSse: (request: Request) => Promise<Response>;
}

const methodNotAllowed = (allowed: 'GET' | 'POST'): Response =>
  Response.json(
    { error: { message: `This endpoint requires ${allowed}.`, reason: 'method-not-allowed' }, ok: false },
    { headers: { allow: allowed }, status: 405 },
  );

export const createControlExplicitHttpAdapters = (
  dependencies: ControlExplicitHttpDependencies,
): ControlExplicitHttpAdapters => ({
  sourceControlCommand: async (request) => {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST');
    }
    return await dependencies.handleCommand(request);
  },
  sourceControlSse: async (request) => {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await dependencies.handleEvents(request);
  },
});

// V5 composes this empty leaf deliberately. Source control never becomes RPC.
export const controlRpcRouter = {} as const;
