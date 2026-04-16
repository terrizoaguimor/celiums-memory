<script lang="ts">
  import { onMount } from 'svelte';

  let { value = 0, label = '', suffix = '', color = '#22c55e', online = true, delta = '', sparkData = [40, 55, 45, 60, 52, 68, 61, 75, 70, 82] }: {
    value: number;
    label: string;
    suffix?: string;
    color?: string;
    online?: boolean;
    delta?: string;
    sparkData?: number[];
  } = $props();

  let displayed = $state(0);

  // Sparkline SVG points
  let points = $derived(() => {
    const min = Math.min(...sparkData);
    const max = Math.max(...sparkData) || 1;
    return sparkData.map((v, i) => {
      const x = (i / (sparkData.length - 1)) * 100;
      const y = 28 - ((v - min) / (max - min)) * 24;
      return `${x},${y}`;
    }).join(' ');
  });

  let lastDotY = $derived(() => {
    const min = Math.min(...sparkData);
    const max = Math.max(...sparkData) || 1;
    return 28 - ((sparkData[sparkData.length - 1] - min) / (max - min)) * 24;
  });

  onMount(() => {
    if (!online || value === 0) { displayed = value; return; }
    const duration = 1800;
    const start = performance.now();
    function step(now: number) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      displayed = Math.round(value * eased);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
</script>

<div class="group relative overflow-hidden rounded-2xl backdrop-blur-sm p-5 transition-all duration-300 hover:translate-y-[-2px]"
  style="border: 1px solid var(--c-border); background: var(--c-surface); box-shadow: var(--c-shadow);"
  onmouseenter={(e) => e.currentTarget.style.borderColor = 'var(--c-border-active)'}
  onmouseleave={(e) => e.currentTarget.style.borderColor = 'var(--c-border)'}>
  <!-- Top glow -->
  <div class="absolute -top-10 -left-10 w-28 h-28 rounded-full opacity-[0.06] group-hover:opacity-[0.12] transition-opacity duration-500"
    style="background: radial-gradient(circle, {color}, transparent 70%);">
  </div>

  <div class="relative">
    <!-- Header -->
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[2px]" style="color: var(--c-text-muted);">{label}</span>
      <div class="w-1.5 h-1.5 rounded-full" style="background: {online ? color : '#eab308'}; box-shadow: 0 0 6px {online ? color : '#eab308'}50;"></div>
    </div>

    <!-- Value or skeleton -->
    {#if online && value > 0}
      <div class="text-3xl font-black tabular-nums tracking-tight mb-1" style="color: {color}">
        {displayed.toLocaleString()}{suffix}
      </div>
    {:else if !online}
      <div class="h-9 w-24 rounded-lg bg-[length:200%_100%] animate-[shimmer_1.8s_infinite] mb-1" style="background: linear-gradient(90deg, var(--c-bg-subtle), var(--c-border), var(--c-bg-subtle));background-size: 200% 100%;"></div>
    {:else}
      <div class="text-3xl font-black tabular-nums tracking-tight mb-1" style="color: var(--c-text-faint);">—</div>
    {/if}

    <!-- Sparkline -->
    <div class="mt-2 h-8 opacity-60 group-hover:opacity-100 transition-opacity">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" class="w-full h-full">
        <defs>
          <linearGradient id="spark-{label}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.25" />
            <stop offset="100%" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points="{points()} 100,30 0,30"
          fill="url(#spark-{label})"
        />
        <polyline
          points={points()}
          fill="none"
          stroke={color}
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="100" cy={lastDotY()} r="2" fill={color} class="animate-pulse" />
      </svg>
    </div>

    <!-- Delta -->
    {#if delta}
      <div class="mt-2 text-[10px]" style="color: var(--c-text-muted);">
        <span style="color: {color}">{delta}</span> vs last session
      </div>
    {/if}
  </div>
</div>

<style>
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
