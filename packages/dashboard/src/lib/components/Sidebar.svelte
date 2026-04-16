<script lang="ts">
  import { page } from '$app/state';
  import ThemeToggle from './ThemeToggle.svelte';

  const nav = [
    { href: '/dashboard', label: 'Dashboard', icon: '◉', desc: 'Overview' },
    { href: '/modules', label: 'Modules', icon: '◈', desc: '5,100 included' },
    { href: '/memory', label: 'Backups', icon: '◎', desc: 'Export & restore' },
    { href: '/settings', label: 'Settings', icon: '◆', desc: 'Engine config' },
  ];
</script>

<aside class="w-56 h-screen fixed left-0 top-0 z-20 flex flex-col
  border-r backdrop-blur-xl"
  style="background: var(--c-sidebar-bg); border-color: var(--c-border);">

  <!-- Logo -->
  <a href="/dashboard" class="flex items-center gap-3 px-5 h-16 border-b group" style="border-color: var(--c-border);">
    <div class="w-2.5 h-2.5 rounded-full bg-[#22c55e] shadow-[0_0_12px_rgba(34,197,94,0.5)] group-hover:shadow-[0_0_20px_rgba(34,197,94,0.7)] transition-shadow"></div>
    <div>
      <span class="text-base font-bold tracking-tight" style="color: var(--c-text);">Celiums</span>
      <span class="block text-[9px] tracking-wider" style="color: var(--c-text-muted);">COGNITIVE ENGINE</span>
    </div>
  </a>

  <!-- Navigation -->
  <nav class="flex-1 py-5 px-3">
    <p class="text-[9px] uppercase tracking-[2px] px-3 mb-3" style="color: var(--c-text-muted);">Navigate</p>
    {#each nav as item}
      {@const isActive = page.url.pathname.startsWith(item.href)}
      <a
        href={item.href}
        class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200 mb-0.5 group relative"
        style="color: {isActive ? 'var(--c-text)' : 'var(--c-text-muted)'}; background: {isActive ? 'var(--c-celiums-dim)' : 'transparent'};"
      >
        {#if isActive}
          <div class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-[#22c55e] rounded-r shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
        {/if}
        <span class="text-xs transition-colors" style="color: {isActive ? '#22c55e' : 'var(--c-text-muted)'};">{item.icon}</span>
        <div>
          <span class="block leading-tight">{item.label}</span>
          <span class="block text-[9px]" style="color: var(--c-text-muted);">{item.desc}</span>
        </div>
      </a>
    {/each}
  </nav>

  <!-- Footer -->
  <div class="px-4 py-4 border-t" style="border-color: var(--c-border);">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <div class="w-1.5 h-1.5 rounded-full bg-[#22c55e] shadow-[0_0_6px_rgba(34,197,94,0.5)]"></div>
        <span class="text-[10px]" style="color: var(--c-text-muted);">Engine Status</span>
      </div>
      <ThemeToggle />
    </div>
    <p class="text-[10px] font-mono" style="color: var(--c-text-muted);">triple-store · v0.7.0</p>
  </div>
</aside>
