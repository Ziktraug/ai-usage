const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const assertFunctionExports: <Module extends object>(
  value: unknown,
  exportNames: readonly (keyof Module & string)[],
  moduleLabel: string,
) => asserts value is Module = (value, exportNames, moduleLabel) => {
  if (!(isRecord(value) && exportNames.every((exportName) => typeof value[exportName] === 'function'))) {
    throw new Error(`Vite did not load ${moduleLabel}`);
  }
};
