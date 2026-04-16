import type { PageServerLoad } from './$types';
import { getHealth, getProfile } from '$lib/server/engine';

export const load: PageServerLoad = async () => {
  try {
    const [health, profile] = await Promise.all([
      getHealth(),
      getProfile('default'),
    ]);

    return {
      status: health.status,
      mode: health.mode,
      limbic: health.limbicState,
      stats: {
        modules: health.knowledge?.moduleCount ?? 0,
        memories: profile?.interactionCount ?? 0,
        interactions: profile?.interaction_count ?? 0,
      },
    };
  } catch {
    return {
      status: 'offline',
      mode: 'unknown',
      limbic: null,
      stats: { modules: 0, memories: 0, interactions: 0 },
    };
  }
};
