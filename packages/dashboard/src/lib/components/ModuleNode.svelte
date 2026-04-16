<script lang="ts">
  let { name = '', displayName = '', category = '', description = '' }: {
    name: string; displayName: string; category: string; description: string;
  } = $props();

  const categoryColors: Record<string, string> = {
    'frontend': '#22c55e', 'backend': '#3b82f6', 'devops': '#f59e0b',
    'ai-ml': '#8b5cf6', 'security': '#ef4444', 'database': '#06b6d4',
    'mobile': '#ec4899', 'design-systems': '#22c55e', 'web-development': '#3b82f6',
    'software-engineering': '#f59e0b', 'data-science': '#06b6d4',
  };
  const color = $derived(categoryColors[category] || '#22c55e');
</script>

<div class="group relative rounded-xl p-5 transition-all duration-300 hover:translate-y-[-2px]"
  style="border: 1px solid var(--c-border); background: var(--c-surface); box-shadow: var(--c-shadow);">

  <div class="absolute top-4 right-4 w-2 h-2 rounded-full opacity-30 group-hover:opacity-100 transition-opacity"
    style="background: {color}; box-shadow: 0 0 12px {color}40;"></div>

  <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium mb-3"
    style="color: {color}; border: 1px solid {color}30; background: {color}08;">
    <span class="w-1 h-1 rounded-full" style="background: {color};"></span>
    {category || 'general'}
  </div>

  <h3 class="text-sm font-semibold mb-1.5 line-clamp-1 transition-colors" style="color: var(--c-text);">
    {displayName || name}
  </h3>

  <p class="text-xs line-clamp-2 leading-relaxed" style="color: var(--c-text-muted);">
    {description || 'Expert knowledge module'}
  </p>

  <div class="mt-3 pt-3 flex items-center justify-between" style="border-top: 1px solid var(--c-border);">
    <span class="text-[9px] font-mono" style="color: var(--c-text-faint);">{name.substring(0, 25)}{name.length > 25 ? '...' : ''}</span>
    <span class="text-[9px] px-2 py-0.5 rounded-full" style="border: 1px solid var(--c-border); color: var(--c-text-muted);">OpenCore</span>
  </div>
</div>
