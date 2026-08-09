export interface ControlExplicitHttpDependencies {
  readonly handleCommand: (request: Request) => Promise<Response>;
  readonly handleEvents: (request: Request) => Promise<Response> | Response;
}

export interface ControlExplicitHttpAdapters {
  readonly sourceControlCommand: (request: Request) => Promise<Response>;
  readonly sourceControlSse: (request: Request) => Promise<Response>;
}

export const createSourceControlCommandAdapter =
  (handleCommand: ControlExplicitHttpDependencies['handleCommand']) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST');
    }
    return await handleCommand(request);
  };

export const createSourceControlSseAdapter =
  (handleEvents: ControlExplicitHttpDependencies['handleEvents']) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await handleEvents(request);
  };

const methodNotAllowed = (allowed: 'GET' | 'POST'): Response =>
  Response.json(
    { error: { message: `This endpoint requires ${allowed}.`, reason: 'method-not-allowed' }, ok: false },
    { headers: { allow: allowed }, status: 405 },
  );

export const createControlExplicitHttpAdapters = (
  dependencies: ControlExplicitHttpDependencies,
): ControlExplicitHttpAdapters => ({
  sourceControlCommand: createSourceControlCommandAdapter(dependencies.handleCommand),
  sourceControlSse: createSourceControlSseAdapter(dependencies.handleEvents),
});

// V5 composes this empty leaf deliberately. Source control never becomes RPC.
export const controlRpcRouter = {} as const;
