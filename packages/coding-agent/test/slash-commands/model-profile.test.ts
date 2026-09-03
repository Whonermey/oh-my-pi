import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BUILTIN_SLASH_COMMANDS,
	buildTuiBuiltinSlashCommands,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

/** Minimal runtime: the text handler touches only settings + output. */
function textRuntime(settings: Settings, output = vi.fn()): SlashCommandRuntime {
	return { settings, output } as unknown as SlashCommandRuntime;
}

describe("/model_profile slash command", () => {
	it("registers with allowArgs and the package icon", () => {
		const command = lookupBuiltinSlashCommand("model_profile");
		expect(command?.name).toBe("model_profile");
		expect(command?.allowArgs).toBe(true);
		expect(command?.icon).toBe("package");
		expect(command?.handle).toBeDefined();
		expect(command?.handleTui).toBeDefined();
	});

	it("activates a saved profile by name", () => {
		const settings = Settings.isolated({
			modelProfiles: { work: { default: "anthropic/claude-sonnet-4" }, research: {} },
		});
		const output = vi.fn();
		const command = lookupBuiltinSlashCommand("model_profile");
		command?.handle?.(parseSlashCommand("/model_profile work")!, textRuntime(settings, output));

		expect(settings.getActiveModelProfile()).toBe("work");
		expect(output).toHaveBeenCalledWith("Model profile: work");
	});

	it("deactivates with the none alias", () => {
		const settings = Settings.isolated({ modelProfiles: { work: {} } });
		const output = vi.fn();
		const command = lookupBuiltinSlashCommand("model_profile");
		command?.handle?.(parseSlashCommand("/model_profile work")!, textRuntime(settings, output));
		expect(settings.getActiveModelProfile()).toBe("work");

		output.mockClear();
		command?.handle?.(parseSlashCommand("/model_profile none")!, textRuntime(settings, output));

		expect(settings.getActiveModelProfile()).toBe("");
		expect(output).toHaveBeenCalledWith("Model profile: none (base roles)");
	});

	it("warns on unknown profile names and lists the saved ones", () => {
		const settings = Settings.isolated({ modelProfiles: { work: {}, research: {} } });
		const output = vi.fn();
		const command = lookupBuiltinSlashCommand("model_profile");
		command?.handle?.(parseSlashCommand("/model_profile nope")!, textRuntime(settings, output));

		expect(output).toHaveBeenCalledWith(expect.stringContaining('Unknown profile "nope"'));
		expect(output).toHaveBeenCalledWith(expect.stringContaining("work"));
		expect(output).toHaveBeenCalledWith(expect.stringContaining("research"));
	});

	it("lists profiles and the active one without arguments", () => {
		const settings = Settings.isolated({ activeModelProfile: "work", modelProfiles: { work: {} } });
		const output = vi.fn();
		const command = lookupBuiltinSlashCommand("model_profile");
		command?.handle?.(parseSlashCommand("/model_profile")!, textRuntime(settings, output));

		expect(output).toHaveBeenCalledWith("Model profiles: work · active: work");
	});

	it("completes saved profile names when materialized with a runtime", async () => {
		const settings = Settings.isolated({ modelProfiles: { work: {}, research: {} } });
		const runtime = { ctx: { settings } } as unknown as TuiSlashCommandRuntime;
		const commands = buildTuiBuiltinSlashCommands(runtime);
		const command = commands.find(cmd => cmd.name === "model_profile");
		const completions = await command?.getArgumentCompletions?.("wor");
		expect(completions?.map(item => item.label)).toContain("work");
	});
});

describe("/model_profile autocomplete through the registry", () => {
	it("appears in the builtin command list", () => {
		expect(BUILTIN_SLASH_COMMANDS.some(cmd => cmd.name === "model_profile")).toBe(true);
	});
});
