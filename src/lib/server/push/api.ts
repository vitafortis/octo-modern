/** Helpers for the /api/push routes: who may manage devices, and the page state. */
import { BadRequest } from '../http.ts';
import { load } from '../notify/settings.ts';
import { listSubscriptions, subscriptionCounts, toDevice } from './subscriptions.ts';
import { vapidKeys } from './vapid.ts';
import type { PushState } from '#lib/push.ts';
import type { User } from '#lib/types.ts';

/** The signed-in person (or the stand-in user with OCM_AUTH=disabled); guests can't subscribe. */
export function pushUser(locals: { user: User | null; auth: string }): User {
	if (!locals.user || (locals.auth !== 'authenticated' && locals.auth !== 'disabled')) throw new BadRequest('Sign in to turn on notifications');
	return locals.user;
}

/** Whether an enabled Browser push channel is used by an enabled rule with events. */
export function pushChannelReady(): boolean {
	const s = load();
	const ids = new Set(s.channels.filter((c) => c.type === 'push' && c.enabled).map((c) => c.id));
	return s.rules.some((r) => r.enabled && r.events.length > 0 && r.channels.some((c) => ids.has(c)));
}

export function pushState(user: User): PushState {
	const state: PushState = { publicKey: vapidKeys().publicKey, devices: listSubscriptions(user.id).map(toDevice), channelReady: pushChannelReady() };
	if (user.role === 'admin') state.counts = subscriptionCounts();
	return state;
}
