export const nextSegmentValue = (values: readonly string[]): string | undefined => {
  const value = values[0];
  return value && value.length > 0 ? value : undefined;
};
