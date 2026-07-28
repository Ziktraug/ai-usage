import { highlightMark } from '@ai-usage/design-system/report';
import { createMemo, For, Show } from 'solid-js';
import { boundedSessionListLabel, caseInsensitiveLiteralMatches } from './session-list-label';

// Marks the filter query inside session titles so a match explains itself.
export const HighlightedText = (props: { text: string; query: string }) => {
  const boundedText = createMemo(() => boundedSessionListLabel(props.text, props.query));
  const segments = createMemo(() => {
    const query = props.query.trim();
    if (!query) {
      return null;
    }
    const text = boundedText();
    const matches = caseInsensitiveLiteralMatches(text, query);
    if (matches.length === 0) {
      return null;
    }
    const parts: { match: boolean; text: string }[] = [];
    let index = 0;
    for (const match of matches) {
      if (match.start > index) {
        parts.push({ match: false, text: text.slice(index, match.start) });
      }
      parts.push({ match: true, text: text.slice(match.start, match.end) });
      index = match.end;
    }
    if (index < text.length) {
      parts.push({ match: false, text: text.slice(index) });
    }
    return parts;
  });

  return (
    <Show fallback={boundedText()} when={segments()}>
      {(parts) => (
        <For each={parts()}>{(part) => (part.match ? <mark class={highlightMark}>{part.text}</mark> : part.text)}</For>
      )}
    </Show>
  );
};
