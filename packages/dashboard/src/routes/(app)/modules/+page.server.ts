import type { PageServerLoad } from './$types';
import { getHealth } from '$lib/server/engine';

export const load: PageServerLoad = async () => {
  try {
    const health = await getHealth();
    return {
      modules: [],
      totalModules: health.knowledge?.moduleCount ?? 5100,
      hasAtlasKey: false,
    };
  } catch {
    return {
      modules: [],
      totalModules: 5100,
      hasAtlasKey: false,
    };
  }
};
