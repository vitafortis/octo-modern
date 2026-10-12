/** A device linked to the signed-in account (the Android app), as My account lists it. */
export interface LinkedDevice {
	id: string;
	name: string;
	platform: string;
	/** First characters of the token, `ocd_AbCdEf`. */
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	/** The device making this request (the app's own entry). */
	current?: boolean;
}
