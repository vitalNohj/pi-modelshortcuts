import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE = 12;

function key(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Searchable model picker. Resolves with the chosen model, or undefined on cancel.
 * Falls back to a plain select dialog outside the terminal UI.
 */
export async function pickModel(
	ctx: ExtensionContext,
	title: string,
	currentTarget: string | undefined,
): Promise<Model<Api> | undefined> {
	const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) => key(a).localeCompare(key(b)));
	if (models.length === 0) {
		ctx.ui.notify("No models with working authentication. Run /login first.", "error");
		return undefined;
	}

	if (ctx.mode !== "tui") {
		const labels = models.map(key);
		const choice = await ctx.ui.select(title, labels);
		return choice ? models[labels.indexOf(choice)] : undefined;
	}

	return ctx.ui.custom<Model<Api> | undefined>((tui, theme, _kb, done) => {
		const input = new Input({ prompt: "> ", placeholder: "type to search provider/model" });
		const border = new DynamicBorder((s) => theme.fg("accent", s));
		let filtered = models;
		let selected = Math.max(0, currentTarget ? models.findIndex((m) => key(m) === currentTarget) : 0);

		const refilter = () => {
			const query = input.getValue().trim();
			filtered = query ? fuzzyFilter(models, query, (m) => `${key(m)} ${m.name ?? ""}`) : models;
			selected = 0;
		};

		const component: Component & Focusable = {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render(width: number): string[] {
				const lines: string[] = [];
				lines.push(...border.render(width));
				lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));
				lines.push(...input.render(width));
				lines.push("");
				if (filtered.length === 0) {
					lines.push(theme.fg("warning", "  No matching models"));
				} else {
					const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));
					const end = Math.min(filtered.length, start + MAX_VISIBLE);
					for (let i = start; i < end; i++) {
						const model = filtered[i];
						const isSel = i === selected;
						const isCurrent = key(model) === currentTarget;
						const label = `${isSel ? "› " : "  "}${key(model)}${isCurrent ? "  (current)" : ""}`;
						const name = model.name && model.name !== model.id ? theme.fg("dim", `  ${model.name}`) : "";
						const styled = isSel ? theme.fg("accent", theme.bold(label)) : label;
						lines.push(truncateToWidth(styled + name, width));
					}
					if (filtered.length > MAX_VISIBLE) {
						lines.push(theme.fg("dim", `  ${selected + 1}/${filtered.length}`));
					}
				}
				lines.push(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"));
				lines.push(...border.render(width));
				return lines;
			},
			invalidate() {
				input.invalidate?.();
				border.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(filtered[selected]);
					return;
				}
				if (matchesKey(data, Key.up)) {
					if (filtered.length) selected = (selected - 1 + filtered.length) % filtered.length;
				} else if (matchesKey(data, Key.down)) {
					if (filtered.length) selected = (selected + 1) % filtered.length;
				} else if (matchesKey(data, Key.pageUp)) {
					selected = Math.max(0, selected - MAX_VISIBLE);
				} else if (matchesKey(data, Key.pageDown)) {
					selected = Math.min(Math.max(0, filtered.length - 1), selected + MAX_VISIBLE);
				} else {
					const before = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== before) refilter();
				}
				tui.requestRender();
			},
		};
		return component;
	});
}
