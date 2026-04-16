import { writable } from 'svelte/store';
import { browser } from '$app/environment';

function createThemeStore() {
  const stored = browser ? localStorage.getItem('celiums-theme') : null;
  const prefersDark = browser ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
  const initial = stored || (prefersDark ? 'dark' : 'light');

  const { subscribe, set } = writable<'light' | 'dark'>(initial as 'light' | 'dark');

  return {
    subscribe,
    toggle: () => {
      let current: string = 'light';
      subscribe(v => current = v)();
      const next = current === 'dark' ? 'light' : 'dark';
      set(next);
      if (browser) {
        localStorage.setItem('celiums-theme', next);
        document.documentElement.classList.toggle('dark', next === 'dark');
      }
    },
    init: () => {
      if (browser) {
        const theme = localStorage.getItem('celiums-theme') ||
          (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        set(theme as 'light' | 'dark');
        document.documentElement.classList.toggle('dark', theme === 'dark');
      }
    },
  };
}

export const theme = createThemeStore();
