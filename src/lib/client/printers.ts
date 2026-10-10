import { goto } from '$app/navigation';
import { page } from '$app/state';
import { api, errorMessage } from './api.ts';
import { confirmAction, editor, refreshPrinters, toast } from './state.svelte.ts';
import type { Printer } from '#lib/types.ts';

/** Confirms, removes a server from octo·modern, and leaves its page if it's open. */
export async function removePrinter(printer: Printer): Promise<boolean> {
	const ok = await confirmAction({
		title: `Remove ${printer.name}?`,
		body: 'octo·modern forgets this server and its API key. OctoPrint and the printer are not touched.',
		detail: printer.baseUrl,
		confirmLabel: 'Remove printer',
		danger: true
	});
	if (!ok) return false;
	try {
		await api.del(`/api/printers/${printer.id}`);
	} catch (err) {
		toast('error', 'Could not remove the printer', errorMessage(err));
		return false;
	}
	await refreshPrinters();
	if (editor.target !== 'new' && editor.target?.id === printer.id) editor.target = null;
	toast('success', 'Printer removed', printer.name);
	if (page.url.pathname.startsWith(`/p/${printer.id}`)) goto('/');
	return true;
}
