/**
 * Notifications. Other features call `notify({ kind, printerId, title?, message?,
 * fields?, … })` with one of the kinds in #lib/notify.ts (`queue.bed_clear_needed`,
 * `spool.low`, `maintenance.due`, `failure.suspected`, `power.off`…); rules decide
 * which channels get it. It never throws.
 */
export { notify, testChannel } from './service.ts';
export type { NotifyEvent, PrintFacts, Image } from './types.ts';
export type { EventKind } from '#lib/notify.ts';
