export const multiSelectSummary = (
  value: readonly string[],
  placeholder: string,
  noun: string,
  optionLabel: (value: string) => string,
): string => {
  if (value.length === 0) {
    return placeholder;
  }
  if (value.length === 1) {
    return optionLabel(value[0] ?? '');
  }
  return `${value.length} ${noun}`;
};
