import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logout } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies }) => {
  const token = cookies.get('celiums_session');
  if (token) {
    logout(token);
    cookies.delete('celiums_session', { path: '/' });
  }
  redirect(302, '/login');
};
