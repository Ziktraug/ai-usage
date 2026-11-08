const TITLE_LIMIT = 500;
const namedEntities: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const decodeEntity = (entity: string, name: string): string => {
  if (!name.startsWith('#')) {
    return namedEntities[name] ?? entity;
  }
  const hex = name.startsWith('#x') || name.startsWith('#X');
  const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  return point > 0 && point <= 0x10_ff_ff && !(point >= 0xd8_00 && point <= 0xdf_ff)
    ? String.fromCodePoint(point)
    : entity;
};

/**
 * Bounded, conservative display-only cleanup; source text stays unchanged.
 * Entities and backslash escapes are decoded once, not to a fixed point. Thus
 * nested encodings/escapes intentionally need not be idempotent. Dunder names
 * are treated as coding identifiers rather than Markdown emphasis.
 */
export const displayTitle = (raw: string): string => {
  const source = raw.trim().slice(0, TITLE_LIMIT);
  const text = source
    // Flattened prompt headings sometimes retain an escaped setext underline.
    .replace(/(?<!\S)\\={3,}(?=\s|$)/gu, '')
    .replace(
      /[A-Za-z]:\\[^\s]+|\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/gu,
      (match: string, punctuation: string | undefined) => punctuation ?? match,
    )
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#[0-9]+|#[xX][0-9a-fA-F]+);/gu, decodeEntity)
    .replace(/^#{1,6}[\t ]+/gmu, '')
    .replace(/^[\t ]*[=-]+[\t ]*$/gmu, '')
    .replace(/(`+)([^`\n]+)\1/gu, '$2')
    .replace(/(?<![\w*])(\*{1,3})([^*\s](?:[^*\n]*?[^*\s])?)\1(?![\w*]|[./\\]\w)/gu, '$2')
    .replace(/(?<![\w_])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w_])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  return text || source;
};

/** A web-only presented row can carry a literal operator/already-presented title. */
export const sessionDisplayTitle = (row: { readonly sessionLabel: string }): string =>
  'displayTitleOverride' in row && typeof row.displayTitleOverride === 'string'
    ? row.displayTitleOverride
    : displayTitle(row.sessionLabel);

export const withSessionDisplayTitle = <Row extends { readonly sessionLabel: string }>(
  row: Row,
  label: string,
): Row & { displayTitleOverride: string } => ({ ...row, sessionLabel: label, displayTitleOverride: label });
