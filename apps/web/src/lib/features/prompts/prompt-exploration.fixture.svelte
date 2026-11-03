<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import { createWebQueryClient } from '../../query/client';
  import type { ExplorationPrompt } from './prompt-exploration';
  import PromptExploration from './prompt-exploration.svelte';

  const queryClient = createWebQueryClient();
  onDestroy(() => queryClient.clear());

  const entries: ExplorationPrompt[] = [
    {
      id: 'one-review',
      rowId: 'one',
      sessionId: 'one',
      project: 'Synthetic alpha',
      harness: 'Codex',
      ordinal: 0,
      at: '2026-10-01T10:00:00Z',
      partial: false,
      text: 'Review this branch PRIVATE_PROMPT_SENTINEL',
    },
    {
      id: 'one-fix',
      rowId: 'one',
      sessionId: 'one',
      project: 'Synthetic alpha',
      harness: 'Codex',
      ordinal: 1,
      at: '2026-10-01T10:01:00Z',
      partial: false,
      text: 'Fix the reported problems',
    },
    {
      id: 'two-review',
      rowId: 'two',
      sessionId: 'two',
      project: 'Synthetic beta',
      harness: 'Claude Code',
      ordinal: 0,
      at: '2026-10-02T10:00:00Z',
      partial: false,
      text: 'Review this branch PRIVATE_PROMPT_SENTINEL',
    },
    {
      id: 'three-review',
      rowId: 'three',
      sessionId: 'three',
      project: 'Synthetic alpha',
      harness: 'Codex',
      ordinal: 0,
      at: '2026-10-09T10:00:00Z',
      partial: true,
      text: 'Please review the code changes',
    },
  ];
  let opened = $state('');
  const onOpen = (entry: ExplorationPrompt) => {
    opened = entry.rowId;
  };
  const page = css({ p: '20px', maxW: '1200px', mx: 'auto', minW: 0, color: 'ink' });
</script>

<main class={page}>
  <h1>Synthetic prompt exploration fixture</h1>
  <p role="status">Opened session: {opened || 'none'}</p>
  <QueryClientProvider client={queryClient}>
    <PromptExploration
      complete={false}
      corpusScope="Synthetic fixture; four prompts across three sessions"
      {entries}
      {onOpen}
      revision="synthetic-prompts-v1"
      synthetic={true}
    />
  </QueryClientProvider>
</main>
