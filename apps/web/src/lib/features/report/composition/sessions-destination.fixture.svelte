<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { provideReportIdentityChannel } from '../core/report-identity-context.svelte';
  import SessionsDestination from './sessions-destination.svelte';

  // The destination publishes its accepted query identity into a context the
  // report shell owns; supply a throwaway channel so SSR tests can render it.
  provideReportIdentityChannel(() => undefined);

  let { destination }: { destination: ComponentProps<typeof SessionsDestination> } = $props();
</script>

<SessionsDestination {...destination} />
