const BUTTON_CLASS_PATTERN = /<button\b[^>]*?\bclass="([^"]*)"/g;
const CLASS_SEPARATOR_PATTERN = /\s+/;

/**
 * Panda emits one atomic class per `condition:property_value`. When an element carries two atoms with
 * the same `condition:property` key (say `bg_surfaceMuted` and `bg_accent` from `cx(button, primary)`),
 * the generated stylesheet order picks the winner, not the order the classes were composed in, and that
 * order can change with any unrelated edit. Lists every such pair on the rendered buttons.
 */
export const conflictingButtonAtoms = (html: string): string[] => {
  const conflicts = new Set<string>();
  for (const [, classAttribute = ''] of html.matchAll(BUTTON_CLASS_PATTERN)) {
    const atomsByKey = new Map<string, string>();
    for (const atom of classAttribute.split(CLASS_SEPARATOR_PATTERN)) {
      const separator = atom.indexOf('_');
      if (separator <= 0 || atom.startsWith('[')) {
        continue;
      }
      const key = atom.slice(0, separator);
      const previous = atomsByKey.get(key);
      if (previous !== undefined && previous !== atom) {
        conflicts.add(`${previous} / ${atom}`);
      }
      atomsByKey.set(key, atom);
    }
  }
  return [...conflicts].sort();
};
