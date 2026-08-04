<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useReportIdentityChannel } from '../core/report-identity-context.svelte';

  let { requestFingerprint, revision }: { requestFingerprint: string | undefined; revision: string | undefined } =
    $props();
  const identityChannel = useReportIdentityChannel();
  let publishedIdentity:
    | {
        readonly requestFingerprint: string;
        readonly revision: string;
      }
    | undefined;

  $effect(() => {
    if (!(requestFingerprint && revision)) {
      return;
    }
    const identity = {
      requestFingerprint,
      revision,
    };
    publishedIdentity = identity;
    identityChannel.publish(identity);
  });

  onDestroy(() => {
    if (publishedIdentity) {
      identityChannel.clear(publishedIdentity);
    }
  });
</script>

<!-- This owner publishes accepted query identity and intentionally renders no UI. -->
