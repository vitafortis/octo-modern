import { plainBody, type ChannelAdapter } from './adapter.ts';
import { imageBlob, imageName, request } from './http.ts';

/** Pushover's API (OCM_PUSHOVER_API overrides it, for tests). */
export const pushoverApi = () => process.env.OCM_PUSHOVER_API || 'https://api.pushover.net/1/messages.json';

export const pushover: ChannelAdapter = {
	type: 'pushover',
	validate: (_c, s) => (/^\w{20,40}$/.test(s.appToken ?? '') && /^\w{20,40}$/.test(s.userKey ?? '') ? null : 'Tokens and keys are 30 letters and digits'),
	async send({ config, secrets, message: m }) {
		const form = new FormData();
		form.set('token', secrets.appToken);
		form.set('user', secrets.userKey);
		form.set('title', m.title.slice(0, 250));
		form.set('message', plainBody(m, { link: false }).slice(0, 1024));
		form.set('priority', m.severity === 'error' ? '1' : '0');
		form.set('timestamp', String(Math.floor(Date.parse(m.at) / 1000)));
		if (m.url) {
			form.set('url', m.url);
			form.set('url_title', 'Open in octo·modern');
		}
		if (config.device) form.set('device', config.device);
		if (config.sound) form.set('sound', config.sound);
		if (m.image) form.set('attachment', imageBlob(m.image), imageName(m.image));
		await request(pushoverApi(), { body: form });
	}
};
