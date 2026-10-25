<script lang="ts">
  import { useOptionalWebQueryRpcContext, useWebQueryRpcContext } from './rpc-context.svelte';

  // Read the way Query consumers read it: optionally where a root provider may be absent, and
  // strictly once one is known to be installed.
  const optional = useOptionalWebQueryRpcContext();
  const required = optional === undefined ? undefined : useWebQueryRpcContext();
</script>

<p
  data-rpc-context={optional === undefined ? 'absent' : 'installed'}
  data-same-context={String(optional === required)}
></p>
