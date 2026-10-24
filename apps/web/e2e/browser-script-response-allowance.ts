interface ScriptResponseIdentity {
  readonly status: number;
  readonly url: string;
}

interface ScriptResponseSlots {
  /** One browser diagnostic per consumed response, each matched at most once. */
  expectedDiagnostics: number;
  /** Matching responses still masked; releasing the allowance revokes the rest. */
  remainingResponses: number;
}

const responseKey = ({ url, status }: ScriptResponseIdentity): string => `${status}:${url}`;
const resourceStatus = /^Failed to load resource: the server responded with a status of (\d+)\b/;

/**
 * A controlled module-download failure may consume up to its declared number of responses, each with
 * its one browser diagnostic; a response beyond that maximum still reaches the failure gate.
 */
export const createBrowserScriptResponseAllowance = () => {
  const slotsByKey = new Map<string, ScriptResponseSlots>();
  const forgetSpent = (key: string, slots: ScriptResponseSlots): void => {
    if (slots.remainingResponses === 0 && slots.expectedDiagnostics === 0 && slotsByKey.get(key) === slots) {
      slotsByKey.delete(key);
    }
  };
  const allowResponses = ({
    maximum,
    ...expectation
  }: ScriptResponseIdentity & { readonly maximum: number }): (() => void) => {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error(`A script response allowance needs a positive integer maximum, not ${maximum}`);
    }
    const key = responseKey(expectation);
    if (slotsByKey.has(key)) {
      throw new Error(`A script response allowance is already active for ${key}`);
    }
    const slots: ScriptResponseSlots = { expectedDiagnostics: 0, remainingResponses: maximum };
    slotsByKey.set(key, slots);
    return () => {
      const observedResponses = maximum - slots.remainingResponses;
      slots.remainingResponses = 0;
      forgetSpent(key, slots);
      if (observedResponses === 0) {
        throw new Error(`Expected script response ${key} was not observed`);
      }
    };
  };
  return {
    allowOnce: (expectation: ScriptResponseIdentity): (() => void) => allowResponses({ ...expectation, maximum: 1 }),
    allowResponses,
    consumeResponse: (response: ScriptResponseIdentity & { readonly resourceType: string }): boolean => {
      const slots = slotsByKey.get(responseKey(response));
      if (response.resourceType !== 'script' || !slots || slots.remainingResponses === 0) {
        return false;
      }
      slots.remainingResponses--;
      slots.expectedDiagnostics++;
      return true;
    },
    consumeConsole: ({ url, message }: { readonly url: string; readonly message: string }): boolean => {
      const status = resourceStatus.exec(message)?.[1];
      if (status === undefined) {
        return false;
      }
      const key = responseKey({ url, status: Number(status) });
      const slots = slotsByKey.get(key);
      if (!slots || slots.expectedDiagnostics === 0) {
        return false;
      }
      slots.expectedDiagnostics--;
      forgetSpent(key, slots);
      return true;
    },
  };
};
