export type ProviderProgressState = { kind: 'determinate'; value: number } | { kind: 'indeterminate' };

export const providerProgressState = (usedPercent: number | null): ProviderProgressState =>
  usedPercent === null ? { kind: 'indeterminate' } : { kind: 'determinate', value: usedPercent };
