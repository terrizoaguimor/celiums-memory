<script lang="ts">
  let { data } = $props();
  let showKey = $state(false);
  let copied = $state('');
  let publicUrl = $state(data.publicUrl || '');

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    copied = label;
    setTimeout(() => copied = '', 2000);
  }

  let openaiSchema = $derived(JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Celiums Memory', version: '0.7.0', description: 'Persistent memory for AI agents with emotional context.' },
    servers: [{ url: publicUrl || 'https://YOUR-URL.trycloudflare.com' }],
    paths: {
      '/store': {
        post: {
          summary: 'Store a memory',
          operationId: 'storeMemory',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' }, userId: { type: 'string' } }, required: ['content'] } } } },
          responses: { '200': { description: 'Memory stored' } },
          security: [{ bearerAuth: [] }],
        },
      },
      '/recall': {
        post: {
          summary: 'Recall memories',
          operationId: 'recallMemories',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, userId: { type: 'string' } }, required: ['query'] } } } },
          responses: { '200': { description: 'Recalled memories' } },
          security: [{ bearerAuth: [] }],
        },
      },
      '/health': {
        get: {
          summary: 'Engine health',
          operationId: 'getHealth',
          responses: { '200': { description: 'Engine status' } },
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  }, null, 2));

  let claudeMcpConfig = $derived(JSON.stringify({
    mcpServers: {
      'celiums-memory': {
        url: `${publicUrl || 'https://YOUR-URL.trycloudflare.com'}/mcp`,
        headers: { Authorization: `Bearer ${data.apiKey}` },
      },
    },
  }, null, 2));
</script>

<svelte:head><title>Settings — Celiums</title></svelte:head>

<div class="max-w-2xl">
  <div class="mb-8">
    <h1 class="text-2xl font-bold mb-1" style="color: var(--c-text);">Settings</h1>
    <p class="text-sm" style="color: var(--c-text-secondary);">Configure your engine and connect AI agents.</p>
  </div>

  <!-- Connection info -->
  <div class="glass-card p-6 mb-4">
    <div class="flex items-center gap-2 mb-4">
      <div class="w-1.5 h-1.5 rounded-full bg-[#22c55e]"></div>
      <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Your Connection</h2>
    </div>

    <!-- API Key -->
    <div class="rounded-lg p-4 mb-4" style="border: 1px solid rgba(34,197,94,0.2); background: rgba(34,197,94,0.04);">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-semibold" style="color: var(--c-text-secondary);">API Key</p>
        <div class="flex gap-2">
          <button class="text-[10px] cursor-pointer" style="color: var(--c-text-muted);" onclick={() => showKey = !showKey}>
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button class="text-[10px] text-[#22c55e] cursor-pointer" onclick={() => copy(data.apiKey, 'key')}>
            {copied === 'key' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <code class="text-sm text-[#22c55e] font-mono block break-all">
        {showKey ? data.apiKey : '•'.repeat(40)}
      </code>
    </div>

    <!-- Public URL -->
    <div class="mb-4">
      <label class="block text-xs font-medium mb-1.5" style="color: var(--c-text-secondary);">Public URL</label>
      <div class="flex gap-2">
        <input type="text" class="input flex-1 font-mono text-sm" placeholder="https://xxx.trycloudflare.com" bind:value={publicUrl} />
        <button class="btn-ghost text-xs" onclick={() => copy(publicUrl, 'url')}>
          {copied === 'url' ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p class="text-[10px] mt-1.5" style="color: var(--c-text-muted);">
        Check your tunnel logs: <code style="color: var(--c-text-secondary);">docker logs celiums-tunnel</code>
      </p>
    </div>
  </div>

  <!-- Connect LLMs -->
  <div class="glass-card p-6 mb-4">
    <div class="flex items-center gap-2 mb-4">
      <div class="w-1.5 h-1.5 rounded-full bg-[#3b82f6]"></div>
      <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Connect Your AI</h2>
    </div>

    <div class="space-y-3">
      <!-- Claude Code -->
      <details class="rounded-lg group" style="border: 1px solid var(--c-border); background: var(--c-surface);">
        <summary class="p-4 flex items-center justify-between cursor-pointer">
          <div class="flex items-center gap-3">
            <span class="text-sm">⌘</span>
            <div>
              <p class="text-sm font-semibold" style="color: var(--c-text);">Claude Code / Cursor / Windsurf</p>
              <p class="text-[10px]" style="color: var(--c-text-muted);">MCP server — auto-configured on install</p>
            </div>
          </div>
          <span class="text-xs" style="color: var(--c-text-muted);">▸</span>
        </summary>
        <div class="px-4 pb-4">
          <code class="text-[11px] text-[#22c55e] px-3 py-2 rounded block font-mono" style="background: var(--c-bg-subtle);">npx @celiums/memory</code>
          <p class="text-[10px] mt-2" style="color: var(--c-text-muted);">Runs locally — connects automatically. No public URL needed.</p>
        </div>
      </details>

      <!-- ChatGPT -->
      <details class="rounded-lg group" style="border: 1px solid var(--c-border); background: var(--c-surface);">
        <summary class="p-4 flex items-center justify-between cursor-pointer">
          <div class="flex items-center gap-3">
            <span class="text-sm">◈</span>
            <div>
              <p class="text-sm font-semibold" style="color: var(--c-text);">ChatGPT (Custom GPT)</p>
              <p class="text-[10px]" style="color: var(--c-text-muted);">OpenAPI schema — requires public URL</p>
            </div>
          </div>
          <span class="text-xs" style="color: var(--c-text-muted);">▸</span>
        </summary>
        <div class="px-4 pb-4">
          <p class="text-[10px] mb-2" style="color: var(--c-text-secondary);">1. Go to ChatGPT → Create a GPT → Actions → Import Schema</p>
          <p class="text-[10px] mb-2" style="color: var(--c-text-secondary);">2. Paste the schema below:</p>
          <div class="relative">
            <pre class="text-[10px] text-[#22c55e] p-3 rounded font-mono overflow-auto max-h-48" style="background: var(--c-bg-subtle);">{openaiSchema}</pre>
            <button class="absolute top-2 right-2 text-[9px] px-2 py-1 rounded cursor-pointer" style="background: var(--c-surface); border: 1px solid var(--c-border); color: var(--c-text-muted);"
              onclick={() => copy(openaiSchema, 'gpt')}>
              {copied === 'gpt' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p class="text-[10px] mt-2" style="color: var(--c-text-secondary);">3. Set Authentication → API Key → Bearer → paste your API key</p>
        </div>
      </details>

      <!-- Claude Web -->
      <details class="rounded-lg group" style="border: 1px solid var(--c-border); background: var(--c-surface);">
        <summary class="p-4 flex items-center justify-between cursor-pointer">
          <div class="flex items-center gap-3">
            <span class="text-sm">◎</span>
            <div>
              <p class="text-sm font-semibold" style="color: var(--c-text);">Claude Web (claude.ai)</p>
              <p class="text-[10px]" style="color: var(--c-text-muted);">Custom connector — OAuth login</p>
            </div>
          </div>
          <span class="text-xs" style="color: var(--c-text-muted);">▸</span>
        </summary>
        <div class="px-4 pb-4 space-y-3">
          <p class="text-[10px]" style="color: var(--c-text-secondary);">1. Go to Claude.ai → Settings → Connectors → Add custom connector</p>
          <div class="space-y-2">
            <div>
              <p class="text-[10px] mb-1" style="color: var(--c-text-muted);">Name:</p>
              <div class="flex gap-2">
                <code class="text-[11px] text-[#22c55e] px-3 py-2 rounded block font-mono flex-1" style="background: var(--c-bg-subtle);">Celiums Memory</code>
                <button class="text-[9px] px-2 rounded cursor-pointer" style="border: 1px solid var(--c-border); color: var(--c-text-muted);"
                  onclick={() => copy('Celiums Memory', 'cname')}>{copied === 'cname' ? '✓' : 'Copy'}</button>
              </div>
            </div>
            <div>
              <p class="text-[10px] mb-1" style="color: var(--c-text-muted);">URL del servidor MCP remoto:</p>
              <div class="flex gap-2">
                <code class="text-[11px] text-[#22c55e] px-3 py-2 rounded block font-mono flex-1" style="background: var(--c-bg-subtle);">{publicUrl || 'https://YOUR-URL.trycloudflare.com'}/mcp</code>
                <button class="text-[9px] px-2 rounded cursor-pointer" style="border: 1px solid var(--c-border); color: var(--c-text-muted);"
                  onclick={() => copy((publicUrl || 'https://YOUR-URL.trycloudflare.com') + '/mcp', 'curl')}>{copied === 'curl' ? '✓' : 'Copy'}</button>
              </div>
            </div>
          </div>
          <p class="text-[10px]" style="color: var(--c-text-secondary);">2. Click "Add" → Claude will redirect to your engine login</p>
          <p class="text-[10px]" style="color: var(--c-text-secondary);">3. Enter your dashboard username & password → Authorize</p>
          <p class="text-[10px]" style="color: var(--c-text-secondary);">4. Done — Claude now has access to your memory engine</p>
        </div>
      </details>

      <!-- REST API -->
      <details class="rounded-lg group" style="border: 1px solid var(--c-border); background: var(--c-surface);">
        <summary class="p-4 flex items-center justify-between cursor-pointer">
          <div class="flex items-center gap-3">
            <span class="text-sm">◆</span>
            <div>
              <p class="text-sm font-semibold" style="color: var(--c-text);">REST API / LangChain / Any LLM</p>
              <p class="text-[10px]" style="color: var(--c-text-muted);">Direct HTTP — works with anything</p>
            </div>
          </div>
          <span class="text-xs" style="color: var(--c-text-muted);">▸</span>
        </summary>
        <div class="px-4 pb-4 space-y-2">
          <p class="text-[10px]" style="color: var(--c-text-secondary);">Store a memory:</p>
          <code class="text-[10px] text-[#22c55e] px-3 py-2 rounded block font-mono break-all" style="background: var(--c-bg-subtle);">curl -X POST {publicUrl || 'http://localhost:3210'}/store -H "Authorization: Bearer {showKey ? data.apiKey : 'YOUR_KEY'}" -H "Content-Type: application/json" -d '&#123;"content":"test memory"&#125;'</code>
          <p class="text-[10px]" style="color: var(--c-text-secondary);">Recall memories:</p>
          <code class="text-[10px] text-[#22c55e] px-3 py-2 rounded block font-mono break-all" style="background: var(--c-bg-subtle);">curl -X POST {publicUrl || 'http://localhost:3210'}/recall -H "Authorization: Bearer {showKey ? data.apiKey : 'YOUR_KEY'}" -H "Content-Type: application/json" -d '&#123;"query":"what do you remember?"&#125;'</code>
          <p class="text-[10px]" style="color: var(--c-text-secondary);">Python (LangChain):</p>
          <code class="text-[10px] text-[#22c55e] px-3 py-2 rounded block font-mono" style="background: var(--c-bg-subtle);">pip install celiums-langchain</code>
        </div>
      </details>
    </div>
  </div>

  <!-- Engine Config -->
  <div class="glass-card p-6 mb-4">
    <div class="flex items-center gap-2 mb-4">
      <div class="w-1.5 h-1.5 rounded-full bg-[#06b6d4]"></div>
      <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Engine</h2>
    </div>
    <div class="space-y-3 text-sm">
      {#each [
        { k: 'Mode', v: 'triple-store' },
        { k: 'Modules', v: '5,100 (OpenCore)' },
        { k: 'Personality', v: 'celiums (OCEAN)' },
        { k: 'Ethics', v: 'Three Laws ✓', c: '#22c55e' },
        { k: 'Version', v: '0.7.0' },
      ] as row}
        <div class="flex justify-between">
          <span style="color: var(--c-text-muted);">{row.k}</span>
          <span class="font-mono" style="color: {row.c || 'var(--c-text-secondary)'};">{row.v}</span>
        </div>
      {/each}
    </div>
  </div>

  <!-- Resources -->
  <div class="glass-card p-6">
    <div class="flex items-center gap-2 mb-4">
      <div class="w-1.5 h-1.5 rounded-full bg-[#f59e0b]"></div>
      <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Resources</h2>
    </div>
    {#each [
      { label: 'GitHub Repository', href: 'https://github.com/terrizoaguimor/celiums-memory' },
      { label: 'Blog & Benchmarks', href: 'https://celiums.ai/blog' },
      { label: 'celiums.ai', href: 'https://celiums.ai' },
    ] as link}
      <a href={link.href} target="_blank" class="flex items-center justify-between py-2 text-sm transition-colors" style="color: var(--c-text-secondary);">
        <span>{link.label}</span><span class="text-xs">→</span>
      </a>
    {/each}
  </div>
</div>
