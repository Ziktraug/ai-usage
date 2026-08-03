<script generics="Destination, Descriptor extends ServedRevisionDescriptor" lang="ts">
  import { onDestroy, type Snippet, untrack } from 'svelte';
  import type { ServedReportSession, ServedRevisionDescriptor } from '../../../../served-report-session';
  import { createServedReportSessionOwner, type ServedReportSessionOwner } from './served-report-session-owner.svelte';

  let {
    children,
    session,
  }: {
    children: Snippet<[ServedReportSessionOwner<Destination, Descriptor>]>;
    session: ServedReportSession<Destination, Descriptor>;
  } = $props();

  const owner = untrack(() => createServedReportSessionOwner(session));
  onDestroy(() => owner.dispose());
</script>

{@render children(owner)}
