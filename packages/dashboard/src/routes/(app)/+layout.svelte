<script lang="ts">
  import '../../app.css';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import NeuralBackground from '$lib/components/NeuralBackground.svelte';
  import { theme } from '$lib/stores/theme';
  import { onMount } from 'svelte';
  let { children } = $props();

  onMount(() => theme.init());
</script>

<div class="flex min-h-screen relative">
  <!-- Neural network background (only in dark mode) -->
  {#if $theme === 'dark'}
    <NeuralBackground />
  {/if}

  <!-- Sidebar -->
  <Sidebar />

  <!-- Main content -->
  <main class="flex-1 ml-56 p-8 relative z-10">
    {@render children()}
  </main>
</div>
