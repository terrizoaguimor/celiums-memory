import type { PageServerLoad } from './$types';
import { getPublicUrl, getVersion } from '$lib/server/runtime-info';
import { getHealth } from '$lib/server/engine';

export const load: PageServerLoad = async ({ locals }) => {
  const [publicUrl, version, health] = await Promise.all([
    getPublicUrl(),
    getVersion(),
    getHealth(),
  ]);

  return {
    apiKey: locals.user?.apiKey ?? '',
    username: locals.user?.username ?? '',
    publicUrl,
    version,
    mode: health?.mode ?? 'unknown',
  };
};
