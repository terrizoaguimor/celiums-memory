<script lang="ts">
  let { data } = $props();
  let creating = $state(false);
  let restoring = $state(false);

  async function createBackup() {
    creating = true;
    try {
      const res = await fetch('/api/engine/backup', { method: 'POST' });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `celiums-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { alert('Backup failed. Is the engine running?'); }
    creating = false;
  }

  let fileInput: HTMLInputElement;
  async function handleRestore() {
    const file = fileInput?.files?.[0];
    if (!file) return;
    if (!confirm('This will merge the backup into your current memories. Continue?')) return;
    restoring = true;
    try {
      const text = await file.text();
      const res = await fetch('/api/engine/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      const result = await res.json();
      alert(`Restored ${result.count ?? 0} memories.`);
    } catch { alert('Restore failed. Check file format.'); }
    restoring = false;
  }
</script>

<svelte:head><title>Backups — Celiums</title></svelte:head>

<div class="max-w-4xl">
  <div class="mb-8">
    <div class="flex items-center gap-3 mb-3">
      <div class="dot"></div>
      <span class="text-[10px] uppercase tracking-[3px]" style="color: var(--c-text-muted);">Data Management</span>
    </div>
    <h1 class="text-3xl font-black tracking-tight mb-2" style="color: var(--c-text);">Backups</h1>
    <p class="text-sm" style="color: var(--c-text-secondary);">Export and restore your memories. Migrate between VPS instances or keep a local copy.</p>
  </div>

  <div class="grid grid-cols-2 gap-4 mb-6">
    <div class="glass-card p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-[#22c55e] text-lg" style="background: rgba(34,197,94,0.1);">↓</div>
        <div>
          <h2 class="text-sm font-semibold" style="color: var(--c-text);">Export Backup</h2>
          <p class="text-[10px]" style="color: var(--c-text-muted);">Download all memories as JSON</p>
        </div>
      </div>
      <p class="text-xs leading-relaxed mb-4" style="color: var(--c-text-secondary);">
        Exports all memories, emotional states, and user profiles. Does not include modules — those ship with the engine.
      </p>
      <button class="btn-primary w-full" onclick={createBackup} disabled={creating}>
        {creating ? 'Creating backup...' : 'Download Backup'}
      </button>
    </div>

    <div class="glass-card p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center text-[#3b82f6] text-lg" style="background: rgba(59,130,246,0.1);">↑</div>
        <div>
          <h2 class="text-sm font-semibold" style="color: var(--c-text);">Restore Backup</h2>
          <p class="text-[10px]" style="color: var(--c-text-muted);">Import memories from a backup file</p>
        </div>
      </div>
      <p class="text-xs leading-relaxed mb-4" style="color: var(--c-text-secondary);">
        Merge a previous backup into your current engine. Existing memories are preserved — duplicates are skipped.
      </p>
      <input type="file" accept=".json" bind:this={fileInput} class="hidden" onchange={handleRestore} />
      <button class="btn-ghost w-full" onclick={() => fileInput?.click()} disabled={restoring}>
        {restoring ? 'Restoring...' : 'Upload Backup File'}
      </button>
    </div>
  </div>

  {#if data.stats}
    <div class="glass-card p-6">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-1.5 h-1.5 rounded-full bg-[#06b6d4]"></div>
        <h2 class="text-xs font-semibold uppercase tracking-wider" style="color: var(--c-text-muted);">Current Memory State</h2>
      </div>
      <div class="grid grid-cols-4 gap-4">
        {#each [
          { value: data.stats.memories ?? 0, label: 'Memories', color: '#22c55e' },
          { value: data.stats.profiles ?? 0, label: 'Profiles', color: '#3b82f6' },
          { value: data.stats.interactions ?? 0, label: 'Interactions', color: '#8b5cf6' },
          { value: data.stats.size ?? '—', label: 'Est. Size', color: '' },
        ] as stat}
          <div class="text-center">
            <div class="text-2xl font-bold" style="color: {stat.color || 'var(--c-text-secondary)'};">{stat.value}</div>
            <div class="text-[10px] mt-1" style="color: var(--c-text-muted);">{stat.label}</div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
