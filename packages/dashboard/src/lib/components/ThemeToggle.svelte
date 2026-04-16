<script lang="ts">
  import { theme } from '$lib/stores/theme';
  import { onMount } from 'svelte';

  onMount(() => theme.init());
</script>

<button
  onclick={() => theme.toggle()}
  class="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--c-input-bg)] cursor-pointer"
  title={$theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
>
  {#if $theme === 'dark'}
    <span class="text-sm">☀</span>
  {:else}
    <span class="text-sm">☽</span>
  {/if}
</button>
