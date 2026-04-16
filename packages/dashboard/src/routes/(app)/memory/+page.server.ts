import type { PageServerLoad } from './$types';
import { getHealth, getProfile } from '$lib/server/engine';

export const load: PageServerLoad = async () => {
  try {
    const profile = await getProfile('default');
    return {
      stats: {
        memories: profile?.interactionCount ?? 0,
        profiles: 0,
        interactions: profile?.interaction_count ?? 0,
        size: null,
      },
    };
  } catch {
    return {
      stats: { memories: 0, profiles: 0, interactions: 0, size: null },
    };
  }
};
