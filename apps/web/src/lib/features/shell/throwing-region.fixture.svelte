<script lang="ts">
  let { fail }: { fail: boolean } = $props();
  const content = $derived.by(() => {
    if (fail) {
      throw new Error('Expected region render failure');
    }
    return 'Region recovered';
  });
</script>
<p>{content}</p>
<button
  onclick={() => {
    fail = true;
  }}
  type="button"
>
  Break region
</button>
