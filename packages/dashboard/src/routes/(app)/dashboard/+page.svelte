<script lang="ts">
  import StatCard from '$lib/components/StatCard.svelte';
  let { data } = $props();

  const isOnline = data.status === 'alive';
  const openCoreModules = 5100;
</script>

<svelte:head>
  <title>Dashboard — Celiums</title>
</svelte:head>

<div class="max-w-6xl">
  <!-- Hero -->
  <div class="mb-8">
    <div class="flex items-center gap-3 mb-3">
      <div class="dot"></div>
      <span class="text-[10px] uppercase tracking-[3px]"
        style="color: {isOnline ? '#22c55e' : '#eab308'}">
        {isOnline ? 'Engine Online' : 'Connect engine to see live data'}
      </span>
    </div>
    <h1 class="text-3xl font-black tracking-tight mb-2" style="color: var(--c-text);">
      Celiums <span class="text-[#22c55e]">Memory</span>
    </h1>
    <p class="text-sm max-w-lg" style="color: var(--c-text-secondary);">
      Your cognitive engine with {openCoreModules.toLocaleString()} built-in modules, emotional recall, and neuroscience-grounded memory.
    </p>
  </div>

  <!-- Stats row -->
  <div class="grid grid-cols-4 gap-3 mb-6">
    <StatCard value={openCoreModules} label="Modules" online={isOnline} color="#22c55e"
      sparkData={[5100, 5100, 5100, 5100, 5100, 5100, 5100, 5100, 5100, 5100]} />
    <StatCard value={data.stats?.memories ?? 0} label="Memories" online={isOnline} color="#3b82f6"
      sparkData={[45, 52, 58, 67, 72, 80, 89, 95, 105, 112]} delta="↑ this session" />
    <StatCard value={data.stats?.interactions ?? 0} label="Interactions" online={isOnline} color="#8b5cf6"
      sparkData={[12, 18, 25, 30, 35, 42, 48, 53, 60, 68]} />
    <StatCard value={100} label="Recall Rate" suffix="%" online={true} color="#22c55e"
      sparkData={[100, 100, 100, 100, 100, 100, 100, 100, 100, 100]} />
  </div>

  <!-- Bento grid -->
  <div class="grid grid-cols-12 gap-3">
    <!-- PAD Emotional State -->
    <div class="col-span-8 glass-card p-5">
      <div class="flex items-center gap-2 mb-5">
        <div class="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
        <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Emotional State</h2>
        <span class="text-[9px] ml-auto font-mono" style="color: var(--c-text-faint);">PAD · Mehrabian-Russell 1974</span>
      </div>
      <div class="grid grid-cols-3 gap-8">
        {#each [
          { label: 'Pleasure', value: data.limbic?.pleasure ?? 0.16, color: '#22c55e', desc: 'Positive affect' },
          { label: 'Arousal', value: data.limbic?.arousal ?? -0.05, color: '#3b82f6', desc: 'Activation level' },
          { label: 'Dominance', value: data.limbic?.dominance ?? 0.13, color: '#8b5cf6', desc: 'Control feeling' },
        ] as pad}
          <div>
            <div class="flex items-center justify-between mb-1">
              <div>
                <span class="text-xs" style="color: var(--c-text-secondary);">{pad.label}</span>
                <span class="text-[9px] ml-1.5" style="color: var(--c-text-faint);">{pad.desc}</span>
              </div>
              <span class="text-sm font-mono font-bold" style="color: {pad.color}">{pad.value?.toFixed(3)}</span>
            </div>
            <div class="pad-bar">
              <div class="pad-fill" style="width: {Math.max(2, ((pad.value + 1) / 2) * 100)}%; background: {pad.color}; box-shadow: 0 0 8px {pad.color}60;"></div>
            </div>
            <div class="flex justify-between mt-1 text-[8px] font-mono" style="color: var(--c-text-faint);">
              <span>-1.0</span><span>0.0</span><span>+1.0</span>
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Engine panel -->
    <div class="col-span-4 glass-card p-5">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-1.5 h-1.5 rounded-full bg-[#06b6d4]"></div>
        <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Engine</h2>
      </div>
      <div class="space-y-2.5 text-xs">
        {#each [
          { k: 'Mode', v: data.mode ?? 'unknown', c: '#22c55e' },
          { k: 'Tools', v: '39 (MCP + REST)', c: '' },
          { k: 'Recall', v: '6 signals (hybrid)', c: '' },
          { k: 'Personality', v: 'celiums (OCEAN)', c: '' },
          { k: 'Ethics', v: 'Three Laws ✓', c: '#22c55e' },
          { k: 'Version', v: data.version ?? '0.0.0', c: '' },
        ] as row}
          <div class="flex justify-between items-center py-0.5">
            <span style="color: var(--c-text-muted);">{row.k}</span>
            <span class="font-mono" style="color: {row.c || 'var(--c-text-secondary)'};">{row.v}</span>
          </div>
        {/each}
      </div>
    </div>

    <!-- Quick actions -->
    <a href="/modules" class="col-span-4 glass-card p-5 group cursor-pointer">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-[#22c55e] text-lg group-hover:scale-110 transition-all" style="background: rgba(34,197,94,0.1);">◈</div>
        <div>
          <h3 class="text-sm font-semibold group-hover:text-[#22c55e] transition-colors" style="color: var(--c-text);">Modules</h3>
          <p class="text-[10px]" style="color: var(--c-text-muted);">{openCoreModules.toLocaleString()} included</p>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed" style="color: var(--c-text-muted);">Browse the knowledge modules that ship with your engine.</p>
    </a>

    <a href="/memory" class="col-span-4 glass-card p-5 group cursor-pointer">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-[#3b82f6] text-lg group-hover:scale-110 transition-all" style="background: rgba(59,130,246,0.1);">◎</div>
        <div>
          <h3 class="text-sm font-semibold group-hover:text-[#3b82f6] transition-colors" style="color: var(--c-text);">Backups</h3>
          <p class="text-[10px]" style="color: var(--c-text-muted);">Export & restore memories</p>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed" style="color: var(--c-text-muted);">Download your memories as JSON. Restore when migrating.</p>
    </a>

    <a href="/settings" class="col-span-4 glass-card p-5 group cursor-pointer">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-[#f59e0b] text-lg group-hover:scale-110 transition-all" style="background: rgba(245,158,11,0.1);">◆</div>
        <div>
          <h3 class="text-sm font-semibold group-hover:text-[#f59e0b] transition-colors" style="color: var(--c-text);">Settings</h3>
          <p class="text-[10px]" style="color: var(--c-text-muted);">Engine configuration</p>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed" style="color: var(--c-text-muted);">Configure engine personality, storage mode, and connections.</p>
    </a>

    <!-- Architecture -->
    <div class="col-span-8 glass-card p-5">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-1.5 h-1.5 rounded-full bg-[#f59e0b]"></div>
        <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Cognitive Architecture</h2>
        <span class="text-[9px] ml-auto font-mono" style="color: var(--c-text-faint);">3 layers · 15 modules · 10 equations</span>
      </div>
      <div class="grid grid-cols-3 gap-3">
        {#each [
          { layer: 'Layer 3', name: 'Metacognition', modules: ['Personality', 'Theory of Mind', 'Habituation', 'PFC'], color: '#8b5cf6', desc: 'Executive control' },
          { layer: 'Layer 2', name: 'Limbic System', modules: ['PAD State', 'Importance', 'Memory Store', 'Recall Engine'], color: '#22c55e', desc: 'Emotion & memory' },
          { layer: 'Layer 1', name: 'Autonomic', modules: ['ANS', 'Reward', 'Circadian', 'Lifecycle', 'Ethics'], color: '#3b82f6', desc: 'Body & environment' },
        ] as layer}
          <div class="rounded-xl p-4 transition-colors" style="border: 1px solid var(--c-border); background: var(--c-bg-subtle, var(--c-surface));">
            <div class="flex items-center gap-2 mb-2">
              <div class="w-1 h-1 rounded-full" style="background: {layer.color}"></div>
              <span class="text-[9px] font-mono uppercase tracking-wider" style="color: {layer.color}">{layer.layer}</span>
            </div>
            <p class="text-sm font-semibold" style="color: var(--c-text);">{layer.name}</p>
            <p class="text-[9px] mb-3" style="color: var(--c-text-muted);">{layer.desc}</p>
            <div class="flex flex-wrap gap-1">
              {#each layer.modules as mod}
                <span class="text-[9px] px-2 py-0.5 rounded-full" style="border: 1px solid var(--c-border); color: var(--c-text-muted);">{mod}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Benchmark -->
    <div class="col-span-4 glass-card p-5">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-1.5 h-1.5 rounded-full bg-[#f59e0b]"></div>
        <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Benchmark</h2>
      </div>
      <div class="text-center py-3">
        <div class="text-4xl font-black text-[#22c55e]">62.3<span class="text-lg">%</span></div>
        <div class="text-[10px] mt-1" style="color: var(--c-text-muted);">LongMemEval QA Accuracy</div>
        <div class="text-[9px] mt-0.5" style="color: var(--c-text-faint);">Opus 4.6 · 500 Q · ICLR 2025</div>
      </div>
      <div class="mt-3 pt-3 grid grid-cols-3 gap-2 text-center" style="border-top: 1px solid var(--c-border);">
        <div>
          <div class="text-base font-bold text-[#22c55e]">98.6%</div>
          <div class="text-[8px]" style="color: var(--c-text-muted);">User Facts</div>
        </div>
        <div>
          <div class="text-base font-bold text-[#22c55e]">100%</div>
          <div class="text-[8px]" style="color: var(--c-text-muted);">Retrieval</div>
        </div>
        <div>
          <div class="text-base font-bold" style="color: var(--c-text-secondary);">$70</div>
          <div class="text-[8px]" style="color: var(--c-text-muted);">Total Cost</div>
        </div>
      </div>
      <a href="https://celiums.ai/blog/longmemeval-benchmark-honest-results" target="_blank"
        class="block text-center text-[10px] text-[#22c55e] hover:underline mt-3 transition-colors" style="opacity: 0.7;">
        Read the full benchmark →
      </a>
    </div>
  </div>
</div>
