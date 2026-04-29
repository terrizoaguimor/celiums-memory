import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { hasUsers } from '$lib/server/auth';
import { listKeys } from '$lib/server/keyvault';
import { getHealth } from '$lib/server/engine';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!hasUsers()) redirect(302, '/setup');
  if (!locals.user) redirect(302, '/login');

  const [keys, health] = await Promise.all([
    listKeys(),
    getHealth(),
  ]);

  return {
    apiKey: locals.user.apiKey,
    username: locals.user.username,
    skipped: url.searchParams.get('skipped') === '1',
    keys,
    health,
  };
};
