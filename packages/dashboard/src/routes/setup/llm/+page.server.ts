import { redirect, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasUsers } from '$lib/server/auth';
import { setKey, listKeys } from '$lib/server/keyvault';
import { PROVIDERS } from '@celiums/memory';

export const load: PageServerLoad = async ({ locals }) => {
  if (!hasUsers()) redirect(302, '/setup');
  if (!locals.user) redirect(302, '/login');
  return {
    providers: PROVIDERS,
  };
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    if (!locals.user) redirect(302, '/login');

    const data = await request.formData();
    const provider = data.get('provider')?.toString().trim() || 'do-inference';
    const value = data.get('value')?.toString().trim() ?? '';
    const model = data.get('model')?.toString().trim() || undefined;

    // Base URL is hardcoded from the provider catalog — not user-overridable
    // from the wizard. Operators who self-host can edit packages/core/src/
    // llm-providers.ts and rebuild.
    if (!PROVIDERS.some((p) => p.id === provider)) {
      return fail(400, { error: 'Unknown provider.' });
    }
    if (!value || value.length < 4) {
      return fail(400, { error: 'Paste a valid API key.' });
    }

    try {
      await setKey({ provider, value, model });
    } catch (err) {
      return fail(500, { error: 'Could not store the key. Try again.' });
    }

    redirect(302, '/setup/welcome');
  },

  skip: async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    redirect(302, '/setup/welcome?skipped=1');
  },
};
