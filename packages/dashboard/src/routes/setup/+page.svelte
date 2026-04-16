<script lang="ts">
  import '../../app.css';
  let { form } = $props();
</script>

<svelte:head>
  <title>Setup — Celiums Memory</title>
</svelte:head>

<div class="min-h-screen flex" style="background: var(--c-bg);">
  <!-- Left panel — dark branding -->
  <div class="hidden lg:flex w-[45%] flex-col justify-between p-12 relative overflow-hidden"
    style="background: #0A0F1A;">

    <!-- Gradient orb -->
    <div class="absolute top-[-20%] right-[-20%] w-[500px] h-[500px] rounded-full opacity-20"
      style="background: radial-gradient(circle, #22c55e, transparent 70%);"></div>
    <div class="absolute bottom-[-10%] left-[-10%] w-[300px] h-[300px] rounded-full opacity-10"
      style="background: radial-gradient(circle, #3b82f6, transparent 70%);"></div>

    <!-- Top: Brand -->
    <div class="relative z-10">
      <div class="flex items-center gap-3 mb-16">
        <div class="w-3 h-3 rounded-full bg-[#22c55e] shadow-[0_0_20px_rgba(34,197,94,0.5)]" style="animation: pulse 2.5s ease-in-out infinite;"></div>
        <span class="text-white text-lg font-bold tracking-tight">Celiums Memory</span>
      </div>

      <h2 class="text-3xl font-black text-white leading-tight mb-4">
        Your AI deserves<br/>a brain that <span class="text-[#22c55e]">remembers</span>.
      </h2>
      <p class="text-[#94A3B8] text-sm leading-relaxed max-w-sm">
        Neuroscience-grounded persistent memory for AI agents. Store what was said AND how it felt.
      </p>
    </div>

    <!-- Middle: Features -->
    <div class="relative z-10 space-y-5">
      {#each [
        { icon: '◈', title: '5,100 Knowledge Modules', desc: 'Expert modules included — forage, absorb, sense.' },
        { icon: '◎', title: 'Emotional Recall', desc: '6 scoring signals, Ebbinghaus decay, PAD model.' },
        { icon: '◉', title: 'Ethics Engine', desc: 'Three Laws structural safety — not a prompt.' },
        { icon: '◆', title: 'MCP + REST + LangChain', desc: 'Connect any AI agent in seconds.' },
      ] as feature}
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center text-[#22c55e] text-sm shrink-0 mt-0.5">{feature.icon}</div>
          <div>
            <p class="text-white text-sm font-medium">{feature.title}</p>
            <p class="text-[#64748B] text-xs">{feature.desc}</p>
          </div>
        </div>
      {/each}
    </div>

    <!-- Bottom: Social proof -->
    <div class="relative z-10">
      <div class="flex items-center gap-4 text-[11px] text-[#475569]">
        <span>Open Source</span>
        <span class="w-1 h-1 rounded-full bg-[#334155]"></span>
        <span>Apache 2.0</span>
        <span class="w-1 h-1 rounded-full bg-[#334155]"></span>
        <span>LongMemEval 62.3%</span>
      </div>
    </div>
  </div>

  <!-- Right panel — form -->
  <div class="flex-1 flex items-center justify-center px-6 lg:px-16">
    <div class="w-full max-w-md">
      <!-- Mobile logo -->
      <div class="lg:hidden flex items-center gap-3 mb-10">
        <div class="dot"></div>
        <span class="text-lg font-bold" style="color: var(--c-text);">Celiums Memory</span>
      </div>

      <div class="mb-8">
        <h1 class="text-2xl font-bold mb-2" style="color: var(--c-text);">Create your account</h1>
        <p class="text-sm" style="color: var(--c-text-secondary);">Set up the admin account for this engine instance. An API key will be generated for connecting AI agents.</p>
      </div>

      {#if form?.error}
        <div class="text-sm p-3 rounded-lg mb-6" style="color: var(--c-error, #ef4444); background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);">
          {form.error}
        </div>
      {/if}

      <form method="POST" class="space-y-5">
        <div>
          <label for="username" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Username</label>
          <input id="username" name="username" type="text" class="input" placeholder="admin" required />
        </div>

        <div>
          <label for="password" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Password</label>
          <input id="password" name="password" type="password" class="input" placeholder="Min 8 characters" required minlength="8" />
        </div>

        <div>
          <label for="confirm" class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Confirm Password</label>
          <input id="confirm" name="confirm" type="password" class="input" placeholder="Repeat password" required />
        </div>

        <button type="submit" class="btn-primary w-full py-3 text-base">Create Account</button>
      </form>

      <p class="text-[11px] mt-8 leading-relaxed" style="color: var(--c-text-muted);">
        This creates a local admin account on this engine instance. Your credentials are stored locally with scrypt hashing — never sent externally.
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
