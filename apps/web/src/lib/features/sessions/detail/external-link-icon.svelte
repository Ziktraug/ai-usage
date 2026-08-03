<script lang="ts">
  let { size = 13 }: { size?: number } = $props();
</script>

<svg
  aria-hidden="true"
  fill="none"
  height={size}
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  stroke-width="2"
  viewBox="0 0 24 24"
  width={size}
  xmlns="http://www.w3.org/2000/svg"
>
  <path d="M15 3h6v6"></path>
  <path d="m10 14 11-11"></path>
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
</svg>
