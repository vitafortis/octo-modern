/** `12.3 MB` for audit lines. */
export function bytesLabel(n: number): string {
	if (!Number.isFinite(n)) return '?';
	const units = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
