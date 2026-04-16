<script lang="ts">
  let { data } = $props();
  const mod = data.module;

  // Show first 30% of content, blur the rest
  const contentLines = (mod?.content || mod?.raw || '').split('\n');
  const previewCut = Math.max(10, Math.floor(contentLines.length * 0.3));
  const visibleContent = contentLines.slice(0, previewCut).join('\n');
  const blurredContent = contentLines.slice(previewCut).join('\n');
  const hasMore = contentLines.length > previewCut;
</script>

<svelte:head>
  <title>{mod?.display_name || mod?.name || 'Module'} — Celiums</title>
</svelte:head>

<div class="max-w-4xl">
  <!-- Back -->
  <a href="/modules" class="text-xs text-white/20 hover:text-white/40 transition-colors mb-6 inline-block">
    ← Back to modules
  </a>

  {#if data.error}
    <div class="glass-card p-8 text-center">
      <div class="dot mx-auto mb-4"></div>
      <p class="text-white/40 mb-2">Module not found or unavailable</p>
      <p class="text-xs text-white/15">{data.error}</p>
    </div>
  {:else if mod}
    <!-- Header -->
    <div class="glass-card p-6 mb-4">
      <div class="flex items-start justify-between mb-3">
        <div>
          <h1 class="text-2xl font-bold text-white mb-1">{mod.display_name || mod.name}</h1>
          <p class="text-sm text-white/30">{mod.description || ''}</p>
        </div>
        <div class="flex items-center gap-2">
          {#if mod.category}
            <span class="text-[10px] px-3 py-1 rounded-full border border-[#22c55e]/20 text-[#22c55e]/70 bg-[#22c55e]/5">
              {mod.category}
            </span>
          {/if}
          {#if mod.eval}
            <span class="text-[10px] px-3 py-1 rounded-full border border-[#f59e0b]/20 text-[#f59e0b]/70 bg-[#f59e0b]/5">
              eval: {mod.eval}
            </span>
          {/if}
        </div>
      </div>
      <div class="flex gap-4 text-[10px] text-white/15 font-mono">
        <span>{mod.line_count || contentLines.length} lines</span>
        <span>{mod.name}</span>
        {#if mod.keywords?.length}
          <span>{mod.keywords.join(', ')}</span>
        {/if}
      </div>
    </div>

    <!-- Content preview -->
    <div class="glass-card p-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
          <h2 class="text-xs font-semibold text-white/40 uppercase tracking-wider">Content Preview</h2>
        </div>
        <span class="text-[9px] text-white/10">Showing {Math.round((previewCut / contentLines.length) * 100)}% of module</span>
      </div>

      <!-- Visible content -->
      <div class="prose prose-invert prose-sm max-w-none
        prose-headings:text-white prose-p:text-white/50
        prose-code:text-[#22c55e] prose-code:bg-white/[0.04] prose-code:text-xs
        prose-pre:bg-white/[0.02] prose-pre:border prose-pre:border-white/[0.04] prose-pre:rounded-xl
        prose-a:text-[#22c55e]">
        {@html visibleContent.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}
      </div>

      <!-- Blurred content -->
      {#if hasMore}
        <div class="relative mt-4">
          <div class="blurred text-sm text-white/30 max-h-48 overflow-hidden">
            {@html blurredContent.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}
          </div>
          <!-- Upgrade overlay -->
          <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-[#050505] via-[#050505]/80 to-transparent">
            <div class="text-center">
              <div class="dot mx-auto mb-3"></div>
              <p class="text-sm font-semibold text-white/60 mb-1">Unlock full module</p>
              <p class="text-xs text-white/25 mb-4 max-w-xs">
                Upgrade to load this module into your engine with full content access.
              </p>
              <a href="/settings" class="btn-primary inline-block text-sm">Upgrade — from $19/mo</a>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
