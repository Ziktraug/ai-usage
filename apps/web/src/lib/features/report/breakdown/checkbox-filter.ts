export const checkboxFilterSummary = (
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

export const toggleCheckboxFilterOption = (
  value: readonly string[],
  options: readonly string[],
  option: string,
  checked: boolean,
): string[] => {
  const knownOptions = new Set(options);
  const selected = new Set(value.filter((candidate) => knownOptions.has(candidate)));
  if (checked) {
    selected.add(option);
  } else {
    selected.delete(option);
  }
  const knownSelection = options.filter((candidate) => selected.has(candidate));
  const unknownSelection = value.filter((candidate) => !knownOptions.has(candidate));
  const next = [...knownSelection, ...unknownSelection];
  return knownSelection.length === options.length && unknownSelection.length === 0 ? [] : next;
};

export const checkboxFilterIncludedCount = (value: readonly string[], options: readonly string[]): number => {
  if (value.length === 0) {
    return options.length;
  }
  const selected = new Set(value);
  return options.filter((option) => selected.has(option)).length;
};
