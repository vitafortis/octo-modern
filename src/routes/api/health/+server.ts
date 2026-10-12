import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Liveness, public. `app` lets clients (the Android app's server check) tell octo·modern apart. */
export const GET: RequestHandler = () => json({ ok: true, app: 'octo-modern' });
