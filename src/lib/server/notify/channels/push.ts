import { DeliveryError } from './http.ts';
import type { ChannelAdapter } from './adapter.ts';
import { deliver, isAudience } from '../../push/deliver.ts';

const publicUrlOf = (url: string | null) => {
	try {
		return url ? new URL(url).origin : (process.env.ORIGIN ?? null);
	} catch {
		return null;
	}
};

/**
 * Browser push: to the subscribed devices of the people in the channel's audience who
 * can see the printer. Fails only when no device got it and at least one should have.
 */
export const push: ChannelAdapter = {
	type: 'push',
	validate: (c) => (!c.audience || isAudience(c.audience) ? null : 'Choose who gets the notifications'),
	async send({ config, message }) {
		const audience = isAudience(config.audience) ? config.audience : 'all';
		const r = await deliver(message, audience, { publicUrl: publicUrlOf(message.url) });
		if (r.total === 0) throw new DeliveryError('No device has browser notifications turned on yet (My account → Browser push)');
		if (r.targets > 0 && r.sent === 0) {
			if (r.failed) throw new DeliveryError(`${r.failed} of ${r.targets} device${r.targets === 1 ? '' : 's'} failed: ${r.errors.join('; ')}`);
			throw new DeliveryError(`${r.gone} device${r.gone === 1 ? ' was' : 's were'} unsubscribed at the push service and removed`);
		}
	}
};
