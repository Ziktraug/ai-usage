import { highlightMark } from '@ai-usage/design-system';
import { createMemo, For, Show } from 'solid-js';

// Marks the filter query inside session titles so a match explains itself.
export const HighlightedText = (props: { text: string; query: string }) => {
  const segments = createMemo(() => {
    const query = props.query.trim().toLowerCase();
    if (!query) return null;
    const lower = props.text.toLowerCase();
    if (!lower.includes(query)) return null;
    const parts: { match: boolean; text: string }[] = [];
    let index = 0;
    while (index < props.text.length) {
      const found = lower.indexOf(query, index);
      if (found === -1) {
        parts.push({ match: false, text: props.text.slice(index) });
        break;
      }
      if (found > index) parts.push({ match: false, text: props.text.slice(index, found) });
      parts.push({ match: true, text: props.text.slice(found, found + query.length) });
      index = found + query.length;
    }
    return parts;
  });

  return (
    <Show when={segments()} fallback={props.text}>
      {(parts) => (
        <For each={parts()}>{(part) => (part.match ? <mark class={highlightMark}>{part.text}</mark> : part.text)}</For>
      )}
    </Show>
  );
};
