<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import WorkAttempts from './work-attempts.svelte';

  let { attempts }: { attempts: ComponentProps<typeof WorkAttempts> } = $props();
</script>

<WorkAttempts {...attempts} />
