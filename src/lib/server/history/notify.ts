/**
 * Notifications live in src/lib/server/notify/ (channels, rules, quiet hours, delivery
 * log). This re-export keeps old imports working: call `notify(event)` with a kind from
 * #lib/notify.ts.
 */
export { notify } from '../notify/index.ts';
export type { NotifyEvent, EventKind } from '../notify/index.ts';
