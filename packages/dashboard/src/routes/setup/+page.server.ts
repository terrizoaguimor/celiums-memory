import { redirect, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasUsers, createUser, login } from '$lib/server/auth';

export const load: PageServerLoad = async () => {
  if (hasUsers()) redirect(302, '/login');
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    if (hasUsers()) redirect(302, '/login');

    const data = await request.formData();
    const username = data.get('username')?.toString().trim();
    const password = data.get('password')?.toString();
    const confirm = data.get('confirm')?.toString();

    if (!username || username.length < 3 || username.length > 64) {
      return fail(400, { error: 'Username must be 3-64 characters.' });
    }

    if (!password || password.length < 8 || password.length > 128) {
      return fail(400, { error: 'Password must be 8-128 characters.' });
    }

    if (password !== confirm) {
      return fail(400, { error: 'Passwords do not match.' });
    }

    try {
      createUser(username, password);

      const token = login(username, password);
      if (token) {
        const isHttps = process.env.ORIGIN?.startsWith('https');
        cookies.set('celiums_session', token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: !!isHttps,
          maxAge: 7 * 24 * 60 * 60,
        });
      }

      redirect(302, '/setup/llm');
    } catch (err: any) {
      return fail(500, { error: 'Setup failed. Please try again.' });
    }
  },
};
