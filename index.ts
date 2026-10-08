import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type Config,
	commandNames,
	configPath,
	loadConfig,
	NAME_PATTERN,
	normalizeName,
	RESERVED_NAMES,
	type Slot,
	saveConfig,
	slotTarget,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./src/config.ts";
import { pickModel } from "./src/model-picker.ts";

const CARD_TYPE = "modelshortcuts-card";
const STATUS_KEY = "modelshortcuts";

interface CardData {
	slots: Slot[];
	active?: string;
}

export default function modelshortcuts(pi: ExtensionAPI) {
	// Commands can only be registered while the extension loads, so the set of
	// slash commands is fixed per runtime. Setup reloads Pi when it changes.
	const { config: loaded, warnings } = loadConfig();
	const registeredNames = commandNames(loaded);

	for (const slot of loaded.slots) {
		pi.registerCommand(slot.name, {
			description: describeSlot(slot),
			handler: async (_args, ctx) => swapTo(slot.name, ctx),
		});
	}

	pi.registerCommand("modelshortcuts", {
		description: "Show model shortcuts; `/modelshortcuts setup` to configure",
		getArgumentCompletions: (prefix) =>
			["setup"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "setup") return runSetup(ctx);
			if (sub && sub !== "list") {
				ctx.ui.notify(`Unknown subcommand "${sub}". Use /modelshortcuts or /modelshortcuts setup`, "warning");
				return;
			}
			showCard(ctx);
		},
	});

	pi.registerEntryRenderer<CardData>(CARD_TYPE, (entry, _opts, theme) => {
		const data = entry.data ?? { slots: [] };
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("accent", theme.bold("Model shortcuts")), 0, 0));
		box.addChild(new Spacer(1));
		if (data.slots.length === 0) {
			box.addChild(new Text(theme.fg("muted", "No commands yet. Run /modelshortcuts setup"), 0, 0));
		}
		const width = Math.max(...data.slots.map((s) => s.name.length + 1), 0);
		for (const slot of data.slots) {
			const cmd = `/${slot.name}`.padEnd(width);
			const target = slotTarget(slot);
			const isActive = data.active === slot.name;
			const left = theme.fg(isActive ? "success" : "accent", theme.bold(cmd));
			const right = target
				? `${target}${theme.fg("muted", `  thinking:${slot.thinkingLevel ?? "pi default"}`)}`
				: theme.fg("warning", "not set");
			box.addChild(new Text(`${left}   ${right}${isActive ? theme.fg("success", "  ● active") : ""}`, 0, 0));
		}
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("dim", "/modelshortcuts setup  add, rename, rebind or remove commands"), 0, 0));
		return box;
	});

	pi.on("session_start", (_event, ctx) => {
		for (const warning of warnings) ctx.ui.notify(`modelshortcuts: ${warning}`, "warning");
		updateStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	function describeSlot(slot: Slot): string {
		const target = slotTarget(slot);
		if (!target) return "Model shortcut (not set - run /modelshortcuts setup)";
		return `Swap to ${target}${slot.thinkingLevel ? ` (thinking ${slot.thinkingLevel})` : ""}`;
	}

	/** Slot whose model matches the current model, if any. */
	function activeSlot(ctx: ExtensionContext, config: Config): Slot | undefined {
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return current ? config.slots.find((s) => slotTarget(s) === current) : undefined;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const slot = activeSlot(ctx, loadConfig().config);
		ctx.ui.setStatus(STATUS_KEY, slot ? ctx.ui.theme.fg("accent", `/${slot.name}`) : undefined);
	}

	function showCard(ctx: ExtensionContext) {
		const { config } = loadConfig();
		const active = activeSlot(ctx, config)?.name;
		if (ctx.hasUI) {
			pi.appendEntry<CardData>(CARD_TYPE, { slots: config.slots, active });
			return;
		}
		const lines = config.slots.map((s) => `/${s.name}  ${slotTarget(s) ?? "not set"}`);
		console.log(lines.join("\n"));
	}

	async function swapTo(name: string, ctx: ExtensionCommandContext) {
		// Read the file at call time so rebinding a model takes effect without a reload.
		const config = loadConfig().config;
		let slot = config.slots.find((s) => s.name === name);
		if (!slot) {
			ctx.ui.notify(`/${name} was removed. Run /modelshortcuts setup`, "warning");
			return;
		}
		if (!slotTarget(slot)) {
			if (!ctx.hasUI) return;
			const model = await pickModel(ctx, `Pick a model for /${name}`, undefined);
			if (!model) return;
			slot.provider = model.provider;
			slot.model = model.id;
			saveConfig(config);
		}
		const target = slotTarget(slot)!;
		const model = ctx.modelRegistry.find(slot.provider!, slot.model!);
		if (!model) {
			ctx.ui.notify(`/${name}: model ${target} not found. Rebind it with /modelshortcuts setup`, "error");
			return;
		}
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`/${name}: no credentials for ${target}. Run /login`, "error");
			return;
		}
		// setModel already applied Pi's default level for this model; override only if the slot pins one.
		if (slot.thinkingLevel) pi.setThinkingLevel(slot.thinkingLevel);
		const source = slot.thinkingLevel ? "" : " (Pi default)";
		ctx.ui.notify(`/${name} → ${target} · thinking ${pi.getThinkingLevel()}${source}`, "info");
	}

	// ---------------------------------------------------------------- setup

	async function runSetup(ctx: ExtensionCommandContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Setup needs the interactive UI. Edit ${configPath()} instead.`, "warning");
			return;
		}
		const ADD = "+ Add a command";
		const DONE = "✓ Done";
		while (true) {
			const config = loadConfig().config;
			const width = Math.max(...config.slots.map((s) => s.name.length + 1), 0);
			const rows = config.slots.map(
				(s) =>
					`/${s.name}`.padEnd(width) +
					`   ${slotTarget(s) ?? "(not set)"}  · thinking ${s.thinkingLevel ?? "pi default"}`,
			);
			const choice = await ctx.ui.select("Model shortcuts setup", [...rows, ADD, DONE]);
			if (choice === undefined || choice === DONE) break;
			if (choice === ADD) {
				await addSlot(ctx, config);
				continue;
			}
			const slot = config.slots[rows.indexOf(choice)];
			if (slot) await editSlot(ctx, config, slot);
		}
		await finishSetup(ctx);
	}

	async function promptName(ctx: ExtensionContext, config: Config, title: string, exclude?: string) {
		while (true) {
			const raw = await ctx.ui.input(title, "e.g. thinker");
			if (raw === undefined) return undefined;
			const name = normalizeName(raw);
			if (!name) return undefined;
			let problem: string | undefined;
			if (!NAME_PATTERN.test(name)) problem = "use lowercase letters, digits, - or _ (max 32)";
			else if (RESERVED_NAMES.has(name)) problem = `/${name} is a built-in Pi command`;
			else if (name !== exclude && config.slots.some((s) => s.name === name)) problem = `/${name} already exists`;
			else if (name !== exclude && pi.getCommands().some((c) => c.name === name))
				problem = `/${name} is already used by another extension, prompt or skill`;
			if (!problem) return name;
			ctx.ui.notify(problem, "warning");
		}
	}

	async function addSlot(ctx: ExtensionCommandContext, config: Config) {
		const name = await promptName(ctx, config, "New command name");
		if (!name) return;
		const model = await pickModel(ctx, `Pick a model for /${name}`, undefined);
		if (!model) return;
		config.slots.push({ name, provider: model.provider, model: model.id });
		saveConfig(config);
	}

	async function editSlot(ctx: ExtensionCommandContext, config: Config, slot: Slot) {
		const MODEL = "Change model";
		const THINK = "Thinking level";
		const RENAME = "Rename command";
		const REMOVE = "Remove command";
		const BACK = "← Back";
		while (true) {
			const head = `/${slot.name} → ${slotTarget(slot) ?? "(not set)"} · thinking ${slot.thinkingLevel ?? "pi default"}`;
			const action = await ctx.ui.select(head, [MODEL, THINK, RENAME, REMOVE, BACK]);
			if (action === undefined || action === BACK) return;
			if (action === MODEL) {
				const model = await pickModel(ctx, `Pick a model for /${slot.name}`, slotTarget(slot));
				if (model) {
					slot.provider = model.provider;
					slot.model = model.id;
				}
			} else if (action === THINK) {
				await pickThinking(ctx, slot);
			} else if (action === RENAME) {
				const name = await promptName(ctx, config, `Rename /${slot.name} to`, slot.name);
				if (name) slot.name = name;
			} else if (action === REMOVE) {
				if (await ctx.ui.confirm("Remove command?", `/${slot.name} will be removed.`)) {
					config.slots.splice(config.slots.indexOf(slot), 1);
					saveConfig(config);
					return;
				}
			}
			saveConfig(config);
		}
	}

	/**
	 * The level Pi itself applies when switching to this slot's model, mirroring
	 * Pi's own rule: per-model setting, else the global default, else the session's
	 * current level. Clamped to what the model supports.
	 */
	function piDefaultThinking(ctx: ExtensionContext, slot: Slot): ThinkingLevel | undefined {
		const settings = pi.getSettings();
		const target = slotTarget(slot);
		const perModel = target ? settings.modelThinkingLevels?.[target] : undefined;
		const raw = perModel ?? settings.defaultThinkingLevel;
		if (!raw) return undefined;
		const model = target ? ctx.modelRegistry.find(slot.provider!, slot.model!) : undefined;
		return (model ? clampThinkingLevel(model, raw) : raw) as ThinkingLevel;
	}

	async function pickThinking(ctx: ExtensionCommandContext, slot: Slot) {
		const BACK = "← Back";
		const def = piDefaultThinking(ctx, slot);
		const DEFAULT = def ? `Use Pi default (${def})` : "Use Pi default";
		const model = slotTarget(slot) ? ctx.modelRegistry.find(slot.provider!, slot.model!) : undefined;
		const levels = (model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS]) as ThinkingLevel[];
		const mark = (label: string, on: boolean) => (on ? `${label}  ✓` : label);
		const options = [
			mark(DEFAULT, !slot.thinkingLevel),
			...levels.map((l) => mark(l, slot.thinkingLevel === l)),
			BACK,
		];
		const choice = await ctx.ui.select(`Thinking level for /${slot.name}`, options);
		if (choice === undefined || choice === BACK) return;
		const index = options.indexOf(choice);
		if (index === 0) delete slot.thinkingLevel;
		else slot.thinkingLevel = levels[index - 1];
	}

	async function finishSetup(ctx: ExtensionCommandContext) {
		const config = loadConfig().config;
		if (commandNames(config) !== registeredNames) {
			ctx.ui.notify("Commands changed - reloading to register them", "info");
			await ctx.reload();
			return; // this runtime is stale after reload
		}
		showCard(ctx);
	}
}
