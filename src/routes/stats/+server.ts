import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Stats moved into History as a tab; old links and bookmarks keep their range and printer. */
export const GET: RequestHandler = ({ url }) => redirect(307, `/history/stats${url.search}`);
