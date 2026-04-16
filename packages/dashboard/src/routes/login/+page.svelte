<script lang="ts">
  import '../../app.css';
  let { form } = $props();
</script>

<svelte:head>
  <title>Sign In — Celiums Memory</title>
</svelte:head>

<div class="min-h-screen flex" style="background: var(--c-bg);">
  <!-- Left panel — dark branding -->
  <div class="hidden lg:flex w-[45%] flex-col justify-between p-12 relative overflow-hidden"
    style="background: #0A0F1A;">

    <!-- Gradient orb -->
    <div class="absolute top-[-20%] right-[-20%] w-[500px] h-[500px] rounded-full opacity-20"
      style="background: radial-gradient(circle, #22c55e, transparent 70%);"></div>

    <!-- Top: Brand -->
    <div class="relative z-10">
      <div class="flex items-center gap-3 mb-12">
        <div class="w-3 h-3 rounded-full bg-[#22c55e] shadow-[0_0_20px_rgba(34,197,94,0.5)]" style="animation: pulse 2.5s ease-in-out infinite;"></div>
        <span class="text-white text-lg font-bold tracking-tight">Celiums Memory</span>
      </div>

      <h2 class="text-3xl font-black text-white leading-tight mb-3">
        Welcome back.
      </h2>
      <p class="text-[#94A3B8] text-sm leading-relaxed max-w-sm">
        Your cognitive engine is waiting. Sign in to manage your memory, modules, and AI connections.
      </p>
    </div>

    <!-- Architecture -->
    <div class="relative z-10 space-y-3">
      <p class="text-[10px] text-[#475569] uppercase tracking-[2px] mb-2">Cognitive Architecture</p>
      {#each [
        { layer: 'L3', name: 'Metacognition', desc: 'Personality · Theory of Mind · Habituation · PFC', color: '#8b5cf6' },
        { layer: 'L2', name: 'Limbic System', desc: 'PAD State · Importance · Memory Store · Recall', color: '#22c55e' },
        { layer: 'L1', name: 'Autonomic', desc: 'ANS · Reward · Circadian · Lifecycle · Ethics', color: '#3b82f6' },
      ] as layer}
        <div class="flex items-start gap-3 p-3 rounded-lg" style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);">
          <span class="text-[10px] font-mono font-bold mt-0.5 shrink-0" style="color: {layer.color}">{layer.layer}</span>
          <div>
            <p class="text-white text-sm font-medium">{layer.name}</p>
            <p class="text-[#475569] text-[11px]">{layer.desc}</p>
          </div>
        </div>
      {/each}
    </div>

    <!-- Stats -->
    <div class="relative z-10">
      <div class="grid grid-cols-4 gap-3">
        {#each [
          { value: '5.1K', label: 'Modules', color: '#22c55e' },
          { value: '6', label: 'Signals', color: '#3b82f6' },
          { value: '10', label: 'Equations', color: '#8b5cf6' },
          { value: '100%', label: 'Recall', color: '#22c55e' },
        ] as stat}
          <div class="rounded-xl p-3 text-center" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);">
            <div class="text-xl font-black" style="color: {stat.color}">{stat.value}</div>
            <div class="text-[9px] text-[#475569] mt-0.5">{stat.label}</div>
          </div>
        {/each}
      </div>
    </div>

    <!-- Bottom -->
    <div class="relative z-10">
      <div class="flex items-center gap-4 text-[11px] text-[#475569]">
        <span>Open Source</span>
        <span class="w-1 h-1 rounded-full bg-[#334155]"></span>
        <span>Apache 2.0</span>
        <span class="w-1 h-1 rounded-full bg-[#334155]"></span>
        <span>celiums.ai</span>
      </div>
    </div>
  </div>

  <!-- Right panel — form -->
  <div class="flex-1 flex items-center justify-center px-6 lg:px-16">
    <div class="w-full max-w-sm">
      <!-- Mobile logo -->
      <div class="lg:hidden flex items-center gap-3 mb-10">
        <div class="dot"></div>
        <span class="text-lg font-bold" style="color: var(--c-text);">Celiums Memory</span>
      </div>

      <div class="mb-8">
        <h1 class="text-2xl font-bold mb-2" style="color: var(--c-text);">Sign in</h1>
        <p class="text-sm" style="color: var(--c-text-secondary);">Enter your credentials to access the dashboard.</p>
      </div>

      {#if form?.error}
        <div class="text-sm p-3 rounded-lg mb-6" style="color: #ef4444; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);">
          {form.error}
        </div>
      {/if}

      <form method="POST" class="space-y-5">
        <div>
          <label for="username" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Username</label>
          <input id="username" name="username" type="text" class="input" required autofocus />
        </div>

        <div>
          <label for="password" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Password</label>
          <input id="password" name="password" type="password" class="input" required />
        </div>

        <button type="submit" class="btn-primary w-full py-3 text-base">Sign In</button>
      </form>

      <p class="text-[11px] mt-8" style="color: var(--c-text-muted);">
        Credentials are validated locally. No external authentication required.
      </p>
    </div>
  </div>
</div>

<style>
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 20px rgba(34, 197, 94, 0.5); }
    50% { box-shadow: 0 0 40px rgba(34, 197, 94, 0.15); }
  }
</style>
