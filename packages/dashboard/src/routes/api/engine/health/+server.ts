import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getHealth } from '$lib/server/engine';

export const GET: RequestHandler = async () => {
  const health = await getHealth();
  return json(health);
};
