import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Slot {
	/** Command name without the leading slash, e.g. "quick". */
	name: string;
	provider?: string;
	model?: string;
	/** Thinking level to apply on swap. Omitted = Pi's default for the model. */
	thinkingLevel?: ThinkingLevel;
}

export interface Config {
	version: 1;
	slots: Slot[];
}

export const DEFAULT_SLOT_NAMES = ["quick", "heavy", "weird"];

/** Commands that Pi itself owns, plus our own entry point. */
export const RESERVED_NAMES = new Set([
	"modelshortcuts",
	"settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
	"name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
	"compact", "resume", "reload", "quit", "llama",
]);

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function configPath(): string {
	return join(getAgentDir(), "modelshortcuts.json");
}

export function defaultConfig(): Config {
	return { version: 1, slots: DEFAULT_SLOT_NAMES.map((name) => ({ name })) };
}

/** Normalize user input like "/Thinker " to "thinker". */
export function normalizeName(raw: string): string {
	return raw.trim().replace(/^\/+/, "").toLowerCase();
}

function parseSlot(value: unknown): Slot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.name !== "string") return undefined;
	const name = normalizeName(v.name);
	if (!NAME_PATTERN.test(name) || RESERVED_NAMES.has(name)) return undefined;
	const slot: Slot = { name };
	if (typeof v.provider === "string" && typeof v.model === "string" && v.provider && v.model) {
		slot.provider = v.provider;
		slot.model = v.model;
	}
	if (typeof v.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(v.thinkingLevel)) {
		slot.thinkingLevel = v.thinkingLevel as ThinkingLevel;
	}
	return slot;
}

export interface LoadResult {
	config: Config;
	warnings: string[];
}

export function loadConfig(): LoadResult {
	const path = configPath();
	if (!existsSync(path)) return { config: defaultConfig(), warnings: [] };
	const warnings: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			config: defaultConfig(),
			warnings: [`${path} is not valid JSON (${(error as Error).message}); using defaults`],
		};
	}
	const slotsRaw = (raw as { slots?: unknown })?.slots;
	if (!Array.isArray(slotsRaw)) {
		return { config: defaultConfig(), warnings: [`${path} has no "slots" array; using defaults`] };
	}
	const seen = new Set<string>();
	const slots: Slot[] = [];
	for (const entry of slotsRaw) {
		const slot = parseSlot(entry);
		if (!slot) {
			warnings.push(`Ignored invalid slot ${JSON.stringify(entry)}`);
			continue;
		}
		if (seen.has(slot.name)) {
			warnings.push(`Ignored duplicate slot /${slot.name}`);
			continue;
		}
		seen.add(slot.name);
		slots.push(slot);
	}
	return { config: { version: 1, slots }, warnings };
}

export function saveConfig(config: Config): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function slotTarget(slot: Slot): string | undefined {
	return slot.provider && slot.model ? `${slot.provider}/${slot.model}` : undefined;
}

export function commandNames(config: Config): string {
	return config.slots
		.map((s) => s.name)
		.sort()
		.join(",");
}
