const coercePrimitive = (value: string): unknown => {
  if (!value) {
    return '';
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  const numberValue = Number(value);
  return numberValue * 0 === 0 && `${numberValue}` === value ? numberValue : value;
};

export const parseTanStackSearch = (input: string | URLSearchParams): Record<string, unknown> => {
  const parameters =
    input instanceof URLSearchParams ? input : new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, rawValue] of parameters) {
    const value = coercePrimitive(rawValue);
    const previous = result[key];
    if (previous == null) {
      result[key] = value;
    } else if (Array.isArray(previous)) {
      previous.push(value);
    } else {
      result[key] = [previous, value];
    }
  }
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (typeof value !== 'string') {
      continue;
    }
    try {
      result[key] = JSON.parse(value) as unknown;
    } catch {
      // TanStack keeps non-JSON strings verbatim.
    }
  }
  return result;
};

const stringifyValue = (value: unknown): unknown => {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return value;
    }
  }
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return value;
    }
  }
  return value;
};

export const stringifyTanStackSearch = (search: Readonly<Record<string, unknown>>): string => {
  const parameters = new URLSearchParams();
  for (const key of Object.keys(search)) {
    const value = search[key];
    if (value !== undefined) {
      parameters.set(key, String(stringifyValue(value)));
    }
  }
  const result = parameters.toString();
  return result ? `?${result}` : '';
};
