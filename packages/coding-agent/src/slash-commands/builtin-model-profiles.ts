/**
 * `/model_profile` — quick model-profile switching.
 *
 * With an argument (`<name>` or `none`) the profile is activated directly;
 * without one a compact picker lists "None (base roles)" and every saved
 * profile. Profiles bundle role→model assignments, so switching affects only
 * models; runtime/session model picks keep precedence.
 */
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import type { Settings } from "../config/settings";
import { ProfilePickerComponent } from "../modes/components/profile-picker";
import type { InteractiveModeContext } from "../modes/types";
import type { ParsedSlashCommand, SlashCommandSpec } from "./types";

/** Activate a profile by name ("" or "none" deactivates), with status feedback. */
function applyProfileArg(
	settings: Settings,
	arg: string,
	ctx: Pick<InteractiveModeContext, "showStatus" | "showWarning">,
): void {
	if (arg === "none") {
		settings.setActiveModelProfile("");
		ctx.showStatus("Model profile: none (base roles)");
		return;
	}
	const profiles = settings.getModelProfiles();
	if (Object.hasOwn(profiles, arg)) {
		settings.setActiveModelProfile(arg);
		ctx.showStatus(`Model profile: ${arg}`);
		return;
	}
	const available = Object.keys(profiles);
	ctx.showWarning(
		`Unknown profile "${arg}".${available.length > 0 ? ` Available: ${available.join(", ")}` : " No profiles saved yet."}`,
	);
}

/** Text/ACP handler: direct argument switch or a profile listing. */
function handleModelProfileText(command: ParsedSlashCommand, settings: Settings, output: (text: string) => void): void {
	const args = command.args.trim();
	if (args.length === 0) {
		const profiles = Object.keys(settings.getModelProfiles());
		const active = settings.getActiveModelProfile();
		output(
			`Model profiles: ${profiles.length > 0 ? profiles.join(", ") : "(none)"}${active ? ` · active: ${active}` : ""}`,
		);
		return;
	}
	applyProfileArg(settings, args, {
		showStatus: output,
		showWarning: output,
	});
}

/** TUI handler: no argument opens the bottom-anchored profile picker overlay. */
function showProfilePicker(runtime: { ctx: InteractiveModeContext }): void {
	const ctx = runtime.ctx;
	ctx.editor.setText("");
	let overlayHandle: OverlayHandle | undefined;
	let closed = false;
	const done = () => {
		if (closed) return;
		closed = true;
		overlayHandle?.hide();
		ctx.ui.requestRender();
	};
	const picker = new ProfilePickerComponent(ctx.ui, ctx.settings, {
		onPick: name => {
			done();
			if (name) {
				ctx.settings.setActiveModelProfile(name);
				ctx.showStatus(`Model profile: ${name}`);
			} else {
				ctx.settings.setActiveModelProfile("");
				ctx.showStatus("Model profile: none (base roles)");
			}
		},
		onCancel: done,
	});
	overlayHandle = ctx.ui.showOverlay(picker, {
		anchor: "bottom-center",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	});
	ctx.ui.setFocus(picker);
	ctx.ui.requestRender();
}

export const BUILTIN_MODEL_PROFILE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "model_profile",
		icon: "package",
		description: "Switch the active model profile (role→model bundle)",
		inlineHint: "[name|none]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const args = command.args.trim();
			if (args.length > 0) {
				applyProfileArg(runtime.ctx.settings, args, runtime.ctx);
				runtime.ctx.editor.setText("");
				return;
			}
			showProfilePicker(runtime);
		},
		handle: (command, runtime) => {
			handleModelProfileText(command, runtime.settings, text => {
				void runtime.output(text);
			});
		},
	},
];
