import type { PageServerLoad } from './$types';
import { absorbModule } from '$lib/server/engine';

export const load: PageServerLoad = async ({ params }) => {
  try {
    const module = await absorbModule(params.slug);
    return { module, error: null };
  } catch (err: any) {
    return { module: null, error: err.message };
  }
};
