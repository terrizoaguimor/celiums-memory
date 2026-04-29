import type { PageServerLoad } from './$types';
import { getHealth, getProfile } from '$lib/server/engine';
import { getPublicUrl, getVersion } from '$lib/server/runtime-info';

export const load: PageServerLoad = async () => {
  try {
    const [health, profile, publicUrl, version] = await Promise.all([
      getHealth(),
      getProfile('default'),
      getPublicUrl(),
      getVersion(),
    ]);

    return {
      status: health.status,
      mode: health.mode,
      limbic: health.limbicState,
      publicUrl,
      version,
      stats: {
        modules: health.knowledge?.moduleCount ?? 0,
        memories: profile?.interactionCount ?? 0,
        interactions: profile?.interaction_count ?? 0,
      },
    };
  } catch {
    const [publicUrl, version] = await Promise.all([getPublicUrl(), getVersion()]);
    return {
      status: 'offline',
      mode: 'unknown',
      limbic: null,
      publicUrl,
      version,
      stats: { modules: 0, memories: 0, interactions: 0 },
    };
  }
};
