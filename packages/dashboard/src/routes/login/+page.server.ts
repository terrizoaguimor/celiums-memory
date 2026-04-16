import { redirect, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasUsers, login } from '$lib/server/auth';

export const load: PageServerLoad = async () => {
  if (!hasUsers()) redirect(302, '/setup');
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const data = await request.formData();
    const username = data.get('username')?.toString().trim();
    const password = data.get('password')?.toString();

    if (!username || !password) {
      return fail(400, { error: 'Username and password required.' });
    }

    if (password.length > 128) {
      return fail(400, { error: 'Password too long.' });
    }

    const token = login(username, password);
    if (!token) {
      return fail(401, { error: 'Invalid username or password.' });
    }

    const isHttps = process.env.ORIGIN?.startsWith('https');
    cookies.set('celiums_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !!isHttps,
      maxAge: 7 * 24 * 60 * 60,
    });

    redirect(302, '/dashboard');
  },
};
