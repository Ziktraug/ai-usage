interface ScriptResponseIdentity {
  readonly status: number;
  readonly url: string;
}

const responseKey = ({ url, status }: ScriptResponseIdentity): string => `${status}:${url}`;
const resourceStatus = /^Failed to load resource: the server responded with a status of (\d+)\b/;

/** A controlled module-download failure may consume one response and its one browser diagnostic. */
export const createBrowserScriptResponseAllowance = () => {
  const expectedResponses = new Set<string>();
  const expectedConsoleErrors = new Set<string>();
  return {
    allowOnce: (expectation: ScriptResponseIdentity): (() => void) => {
      const key = responseKey(expectation);
      if (expectedResponses.has(key) || expectedConsoleErrors.has(key)) {
        throw new Error(`A script response allowance is already active for ${key}`);
      }
      expectedResponses.add(key);
      return () => {
        if (expectedResponses.delete(key)) {
          throw new Error(`Expected script response ${key} was not observed`);
        }
      };
    },
    consumeResponse: (response: ScriptResponseIdentity & { readonly resourceType: string }): boolean => {
      const key = responseKey(response);
      if (response.resourceType !== 'script' || !expectedResponses.delete(key)) {
        return false;
      }
      expectedConsoleErrors.add(key);
      return true;
    },
    consumeConsole: ({ url, message }: { readonly url: string; readonly message: string }): boolean => {
      const status = resourceStatus.exec(message)?.[1];
      return status !== undefined && expectedConsoleErrors.delete(responseKey({ url, status: Number(status) }));
    },
  };
};
