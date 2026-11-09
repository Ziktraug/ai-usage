/** Stable geometry without randomness or client/server differences. */
export const atmosphereContours = (variant: string): readonly string[] => {
  const phase = Array.from(variant).reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 997, 0) % 29;
  return Array.from(
    { length: 36 },
    (_, line) =>
      `M ${-140 + line * 10} 350 C ${100 + line * 5} ${300 - line * 8 + phase}, ${215 + line * 4} ${-105 + line * 4}, ${405 + line * 5} ${54 + line * 5 + phase} S ${530 + line * 8} ${250 - line * 3}, 860 ${-50 + line * 10}`,
  );
};
