/**
 * OctoPrint's custom controls (config.yaml `controls`, served at
 * /api/printer/command/custom): sections with buttons that send G-code or run a GCODE
 * script, optional inputs and sliders, and feedback lines that show a value parsed
 * from the terminal. Parsed into a small tree the Control tab renders. Pure.
 */

export interface ControlInput {
	name: string;
	parameter: string;
	default: string;
	slider: { min: number; max: number; step: number } | null;
}

export type CustomControl =
	| { kind: 'section'; name: string | null; layout: 'vertical' | 'horizontal' | 'horizontal_grid'; collapsed: boolean; children: CustomControl[] }
	| { kind: 'command'; name: string; commands: string[]; confirm: string | null; inputs: ControlInput[] }
	| { kind: 'script'; name: string; script: string; confirm: string | null; inputs: ControlInput[] }
	| { kind: 'output'; name: string | null; regex: string; template: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function parseInputs(raw: unknown): ControlInput[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((r) => {
		const i = obj(r);
		const parameter = str(i.parameter);
		if (!parameter || !/^\w+$/.test(parameter)) return [];
		let slider: ControlInput['slider'] = null;
		if (i.slider && typeof i.slider === 'object') {
			const s = obj(i.slider);
			const min = Number.isFinite(Number(s.min)) ? Number(s.min) : 0;
			const max = Number.isFinite(Number(s.max)) && Number(s.max) > min ? Number(s.max) : Math.max(min + 1, 255);
			const step = Number.isFinite(Number(s.step)) && Number(s.step) > 0 ? Number(s.step) : 1;
			slider = { min, max, step };
		}
		const def = i.default ?? (slider ? slider.min : '');
		return [{ name: str(i.name) ?? parameter, parameter, default: String(def), slider }];
	});
}

function parseOne(raw: unknown, depth: number): CustomControl | null {
	const c = obj(raw);
	if (Array.isArray(c.children)) {
		if (depth > 8) return null;
		const children = c.children.map((ch) => parseOne(ch, depth + 1)).filter((x): x is CustomControl => !!x);
		const layout = c.layout === 'horizontal' || c.layout === 'horizontal_grid' ? c.layout : 'vertical';
		return { kind: 'section', name: str(c.name), layout, collapsed: c.collapsed === true, children };
	}
	const name = str(c.name);
	const confirm = str(c.confirm);
	const script = str(c.script);
	if (script) return { kind: 'script', name: name ?? script, script, confirm, inputs: parseInputs(c.input) };
	const commands = Array.isArray(c.commands) ? c.commands.filter((x): x is string => typeof x === 'string' && !!x.trim()) : str(c.command) ? [c.command as string] : [];
	if (commands.length) return { kind: 'command', name: name ?? commands[0], commands, confirm, inputs: parseInputs(c.input) };
	const regex = str(c.regex);
	const template = str(c.template);
	if (regex && template) return { kind: 'output', name, regex, template };
	// JavaScript-only controls (`javascript`, `enabled`) run in OctoPrint's own UI; skip them.
	return null;
}

/** The control tree from /api/printer/command/custom (`{ controls: [...] }`). Empty sections are dropped. */
export function parseCustomControls(raw: unknown): CustomControl[] {
	const list = Array.isArray(raw) ? raw : obj(raw).controls;
	if (!Array.isArray(list)) return [];
	const prune = (cs: CustomControl[]): CustomControl[] =>
		cs.flatMap((c): CustomControl[] => {
			if (c.kind !== 'section') return [c];
			c.children = prune(c.children);
			return c.children.length ? [c] : [];
		});
	return prune(list.map((c) => parseOne(c, 0)).filter((x): x is CustomControl => !!x));
}

/** Fills `%(name)s`-style placeholders (Python's %-format, which OctoPrint uses) from input values. */
export function fillTemplate(command: string, values: Record<string, string | number>): string {
	return command.replace(/%%|%\((\w+)\)([sdif])/g, (m, key: string | undefined, type: string | undefined) => {
		if (m === '%%') return '%';
		const v = values[key!];
		if (v === undefined) return m;
		if (type === 'd' || type === 'i') return String(Math.trunc(Number(v)) || 0);
		if (type === 'f') return Number(v).toFixed(6);
		return String(v);
	});
}

/** Converts a Python regex to JavaScript where the syntax differs (named groups). */
function jsRegex(source: string): RegExp | null {
	try {
		return new RegExp(source.replace(/\(\?P<(\w+)>/g, '(?<$1>').replace(/\(\?P=(\w+)\)/g, '\\k<$1>'));
	} catch {
		return null;
	}
}

/**
 * A feedback control's text: the newest received terminal line matching its regex,
 * formatted with the template (`{0}`, `{1}` … or `{name}`). Null when nothing matched yet.
 */
export function renderOutput(control: { regex: string; template: string }, lines: readonly string[]): string | null {
	const re = jsRegex(control.regex);
	if (!re) return null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].replace(/^Recv:\s?/, '');
		if (line === lines[i] && /^(Send|Changing|Connecting)\b/.test(line)) continue;
		const m = re.exec(line);
		if (!m) continue;
		return control.template.replace(/\{(\w*)\}/g, (all, key: string) => {
			if (key === '') return m[1] ?? '';
			if (/^\d+$/.test(key)) return m[Number(key) + 1] ?? '';
			return m.groups?.[key] ?? all;
		});
	}
	return null;
}
