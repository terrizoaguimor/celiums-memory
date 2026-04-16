<script lang="ts">
  import ModuleNode from '$lib/components/ModuleNode.svelte';
  let { data } = $props();
  let search = $state('');
  let activeCategory = $state('all');
  let liveModules = $state<any[]>([]);
  let searching = $state(false);
  let searchTimer: any;

  function handleSearch(e: Event) {
    const q = (e.target as HTMLInputElement).value;
    search = q;
    clearTimeout(searchTimer);
    if (!q.trim()) { liveModules = []; return; }
    searchTimer = setTimeout(async () => {
      searching = true;
      try {
        const res = await fetch(`/api/engine/forage?q=${encodeURIComponent(q)}&limit=24`);
        const data = await res.json();
        liveModules = data.modules || [];
      } catch { liveModules = []; }
      searching = false;
    }, 400);
  }

  let displayModules = $derived(search.trim() ? liveModules : data.modules);

  const categories = [
    { id: 'all', label: 'All Modules', color: '#22c55e' },
    { id: 'frontend', label: 'Frontend', color: '#22c55e' },
    { id: 'backend', label: 'Backend', color: '#3b82f6' },
    { id: 'ai-ml', label: 'AI / ML', color: '#8b5cf6' },
    { id: 'devops', label: 'DevOps', color: '#f59e0b' },
    { id: 'database', label: 'Database', color: '#06b6d4' },
    { id: 'security', label: 'Security', color: '#ef4444' },
    { id: 'mobile', label: 'Mobile', color: '#ec4899' },
    { id: 'design-systems', label: 'Design', color: '#a78bfa' },
    { id: 'web-development', label: 'Web Dev', color: '#34d399' },
    { id: 'software-engineering', label: 'Engineering', color: '#fbbf24' },
  ];

  let filtered = $derived(
    displayModules.filter((m: any) => {
      const matchesCategory = activeCategory === 'all' || m.category === activeCategory;
      return matchesCategory;
    })
  );
</script>

<svelte:head>
  <title>Modules — Celiums</title>
</svelte:head>

<div class="max-w-5xl">
  <div class="mb-8">
    <div class="flex items-center gap-3 mb-3">
      <div class="dot"></div>
      <span class="text-[10px] uppercase tracking-[3px]" style="color: var(--c-text-muted);">OpenCore Modules</span>
    </div>
    <h1 class="text-3xl font-black tracking-tight mb-2" style="color: var(--c-text);">
      5,100 <span class="text-[#22c55e]">Free Modules</span>
    </h1>
    <p class="text-sm" style="color: var(--c-text-secondary);">
      These modules ship with your engine — no API key needed. Use forage, absorb, and sense to search them.
    </p>
  </div>

  <div class="relative mb-8">
    <input type="text" class="search-glow pl-12" placeholder="Search modules..." value={search} oninput={handleSearch} />
    <span class="absolute left-5 top-1/2 -translate-y-1/2 text-sm" style="color: var(--c-text-muted);">◈</span>
  </div>

  <div class="flex gap-2 mb-8 flex-wrap">
    {#each categories as cat}
      <button class="constellation" class:active={activeCategory === cat.id} onclick={() => activeCategory = cat.id}>
        <span class="w-1.5 h-1.5 rounded-full" style="background: {activeCategory === cat.id ? '#000' : cat.color}"></span>
        {cat.label}
      </button>
    {/each}
  </div>

  <div class="grid grid-cols-3 gap-3">
    {#each filtered.slice(0, 24) as mod, i}
      <div style="animation: fadeUp 0.4s ease-out {i * 0.03}s both">
        <ModuleNode name={mod.name} displayName={mod.display_name || mod.name} category={mod.category || 'general'} description={mod.description || ''} />
      </div>
    {:else}
      <div class="col-span-3 text-center py-16">
        {#if searching}
          <div class="dot mx-auto mb-4"></div>
          <p class="text-sm" style="color: var(--c-text-muted);">Searching the network...</p>
        {:else if search}
          <p class="text-sm" style="color: var(--c-text-muted);">No modules match your search.</p>
        {:else}
          <p class="text-base font-medium mb-2" style="color: var(--c-text-secondary);">Search to explore modules</p>
          <p class="text-sm" style="color: var(--c-text-muted);">Type a topic like "kubernetes", "react auth", or "python async" to find relevant modules.</p>
        {/if}
      </div>
    {/each}
  </div>

  {#if filtered.length > 24}
    <p class="text-center text-xs mt-8" style="color: var(--c-text-faint);">
      Showing 24 of {filtered.length.toLocaleString()} modules
    </p>
  {/if}

  <div class="glass-card p-8 mt-10">
    <div class="grid grid-cols-2 gap-8 items-center">
      <div>
        <div class="flex items-center gap-2 mb-3">
          <div class="dot"></div>
          <span class="text-[10px] uppercase tracking-[2px]" style="color: var(--c-text-muted);">Connect your AI</span>
        </div>
        <h3 class="text-lg font-bold mb-2" style="color: var(--c-text);">These modules feed your AI agent, not your browser.</h3>
        <p class="text-sm leading-relaxed mb-4" style="color: var(--c-text-secondary);">
          Connect Claude Code, ChatGPT, Gemini, or any MCP-compatible AI to your engine.
        </p>
        <a href="/settings" class="btn-primary inline-block">See connection options</a>
      </div>
      <div class="space-y-2">
        {#each [
          { icon: '⌘', name: 'Claude Code', desc: 'MCP server · forage · absorb' },
          { icon: '◈', name: 'ChatGPT / Gemini / Any LLM', desc: 'REST API · /forage · /absorb' },
          { icon: '◎', name: 'LangChain / LlamaIndex', desc: 'pip install celiums-langchain' },
        ] as item}
          <div class="rounded-lg p-3 flex items-center gap-3" style="border: 1px solid var(--c-border); background: var(--c-surface);">
            <span class="text-sm">{item.icon}</span>
            <div>
              <p class="text-xs font-semibold" style="color: var(--c-text-secondary);">{item.name}</p>
              <p class="text-[10px] font-mono" style="color: var(--c-text-muted);">{item.desc}</p>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
