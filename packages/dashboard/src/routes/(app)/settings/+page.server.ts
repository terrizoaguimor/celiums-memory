import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  return {
    apiKey: locals.user?.apiKey ?? '',
    username: locals.user?.username ?? '',
  };
};
