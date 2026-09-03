/**
 * Compact model-profile picker (opened via `/model_profile`): a bottom-anchored
 * floating overlay listing "None (base roles)" plus every saved profile.
 * Typing filters by substring; Enter activates (switching only model roles);
 * Esc closes. Keyboard-only, since mouse tracking is reserved for fullscreen
 * overlays — mirrors the alt+p model picker.
 */
import { type Component, extractPrintableText, matchesKey, type TUI } from "@oh-my-pi/pi-tui";
import type { Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { bottomBorder, row, topBorder } from "./overlay-box";

export interface ProfilePickerCallbacks {
	/** Pick a profile ("" deactivates — base role config applies). */
	onPick: (name: string) => void;
	onCancel: () => void;
}

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Minimum list rows on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "Model profile — applies its role→model assignments (only models)";
const FOOTER_HINT = "↑/↓ profiles · Enter apply · type to filter · Esc close";

/**
 * The `/model_profile` picker. Hosted as a non-fullscreen bottom-anchored
 * overlay (`ui.showOverlay(..., { anchor: "bottom-center" })`).
 */
export class ProfilePickerComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#callbacks: ProfilePickerCallbacks;
	/** All profile names, stable; "" (None) is always the first row. */
	#allNames: string[] = [];
	/** Profile names matching the current filter. */
	#filteredNames: string[] = [];
	#query = "";
	#index = 0;

	constructor(tui: TUI, settings: Settings, callbacks: ProfilePickerCallbacks) {
		this.#tui = tui;
		this.#settings = settings;
		this.#callbacks = callbacks;
		this.#allNames = Object.keys(settings.getModelProfiles());
		this.#applyFilter();
	}

	invalidate(): void {}

	/** Row index 0 is always "None (base roles)"; profile rows follow. */
	#rowCount(): number {
		return this.#filteredNames.length + 1;
	}

	#applyFilter(): void {
		const lower = this.#query.toLowerCase();
		this.#filteredNames = lower
			? this.#allNames.filter(name => name.toLowerCase().includes(lower))
			: [...this.#allNames];
		this.#index = Math.min(this.#index, Math.max(0, this.#rowCount() - 1));
	}

	#activateRow(): void {
		const name = this.#index === 0 ? "" : (this.#filteredNames[this.#index - 1] ?? "");
		this.#callbacks.onPick(name);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) return; // no mouse outside fullscreen overlays
		if (matchesSelectCancel(data)) {
			this.#callbacks.onCancel();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#index = (this.#index - 1 + this.#rowCount()) % this.#rowCount();
			this.#tui.requestRender();
			return;
		}
		if (matchesSelectDown(data)) {
			this.#index = (this.#index + 1) % this.#rowCount();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateRow();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.#query = this.#query.slice(0, -1);
			this.#applyFilter();
			this.#tui.requestRender();
			return;
		}
		const printable = extractPrintableText(data);
		if (printable !== undefined && printable.trim().length > 0) {
			this.#query += printable;
			this.#applyFilter();
			this.#tui.requestRender();
		}
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.max(MIN_VISIBLE, Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS);
		const visibleCount = Math.min(this.#rowCount(), listBudget);
		const scrollStart = Math.max(0, Math.min(this.#index - visibleCount + 1, this.#rowCount() - visibleCount));

		const inner = Math.max(1, width - 4);
		const active = this.#settings.getActiveModelProfile();
		const profiles = this.#settings.getModelProfiles();

		const lines: string[] = [];
		lines.push(topBorder(width, "Model Profile"));
		lines.push(
			row(
				active ? theme.fg("muted", ` ${STATUS_HINT} · active: ${active}`) : theme.fg("muted", ` ${STATUS_HINT}`),
				width,
			),
		);
		for (let i = scrollStart; i < Math.min(this.#rowCount(), scrollStart + visibleCount); i++) {
			const selected = i === this.#index;
			const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
			if (i === 0) {
				const isActive = !active;
				const dot = isActive ? theme.fg("accent", theme.status.enabled) : theme.fg("dim", theme.status.shadowed);
				const label = isActive
					? theme.bold(theme.fg("accent", "None (base roles)"))
					: theme.fg("dim", "None (base roles)");
				lines.push(row(` ${cursor} ${dot} ${label}`, width));
				continue;
			}
			const name = this.#filteredNames[i - 1];
			if (name === undefined) continue;
			const isActive = active === name;
			const dot = isActive ? theme.fg("accent", theme.status.enabled) : theme.fg("dim", theme.status.shadowed);
			const label = isActive ? theme.bold(theme.fg("accent", name)) : name;
			const roleCount = Object.keys(profiles[name] ?? {}).length;
			const annotation = isActive
				? theme.fg("accent", "active")
				: theme.fg("dim", `${roleCount} role${roleCount === 1 ? "" : "s"}`);
			const body = ` ${cursor} ${dot} ${label}`;
			const bodyWidth = body.length;
			const annWidth = annotation.length;
			const padded =
				bodyWidth + annWidth + 1 <= inner
					? `${body}${" ".repeat(inner - bodyWidth - annWidth)}${annotation}`
					: body;
			lines.push(row(padded, width));
		}
		lines.push(row(theme.fg("dim", FOOTER_HINT), width));
		lines.push(bottomBorder(width));
		return lines;
	}
}
