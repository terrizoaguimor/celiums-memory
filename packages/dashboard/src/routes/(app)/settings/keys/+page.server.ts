import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listKeys } from '$lib/server/keyvault';
import { PROVIDERS } from '@celiums/memory';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const keys = await listKeys();
  return {
    keys,
    providers: PROVIDERS,
  };
};
