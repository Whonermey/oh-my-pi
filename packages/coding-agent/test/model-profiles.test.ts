import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { onModelRolesChanged, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/**
 * Model profiles: named bundles of role→model assignments. A profile is the
 * effective role config while active — it shadows the persisted base layers
 * but never the runtime override layer (CLI --model, session-only picks,
 * cycling). Role edits made while a profile is active route into the profile.
 */
describe("Model profiles", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-profiles-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	const init = () => Settings.init({ cwd: projectDir, agentDir });

	it("merges active profile roles above base config but below runtime overrides", async () => {
		const settings = await init();
		settings.set("modelRoles", { default: "openai/gpt-4o" });
		settings.setModelProfile("work", { default: "anthropic/claude-sonnet-4" });
		settings.setActiveModelProfile("work");

		// Profile shadows base config.
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4");
		// Roles absent from the profile still resolve from base config.
		expect(settings.getModelRole("smol")).toBeUndefined();
		settings.setModelRole("smol", "openai/gpt-4o-mini");
		expect(settings.getModelRole("smol")).toBe("openai/gpt-4o-mini");

		// Deactivation restores base config (runtime override cleared first).
		settings.setActiveModelProfile("");
		settings.clearOverride("modelRoles");
		expect(settings.getModelRole("default")).toBe("openai/gpt-4o");
	});

	it("getModelRoles returns the merged effective record with later sources winning", async () => {
		const settings = await init();
		settings.set("modelRoles", { default: "openai/gpt-4o", slow: "openai/gpt-4o" });
		settings.setModelProfile("work", { default: "anthropic/claude-sonnet-4", plan: "anthropic/claude-opus-4" });
		settings.setActiveModelProfile("work");
		settings.overrideModelRoles({ slow: "google/gemini-2.5-pro" });

		expect(settings.getModelRoles()).toEqual({
			default: "anthropic/claude-sonnet-4",
			slow: "google/gemini-2.5-pro",
			plan: "anthropic/claude-opus-4",
		});
	});

	it("routes role edits into the active profile instead of the base layers", async () => {
		const settings = await init();
		settings.setModelProfile("work", {});
		settings.setActiveModelProfile("work");

		settings.setModelRole("smol", "openai/gpt-4o-mini");
		expect(settings.getModelProfiles().work?.smol).toBe("openai/gpt-4o-mini");
		// Base layer untouched.
		expect(settings.get("modelRoles").smol).toBeUndefined();

		// Clearing a role removes it from the profile and re-exposes base config.
		settings.setModelRole("smol", undefined);
		expect(settings.getModelProfiles().work?.smol).toBeUndefined();
	});

	it("routes project-scoped role edits into the active profile too", async () => {
		const settings = await init();
		settings.setModelProfile("work", {});
		settings.setActiveModelProfile("work");

		settings.setProjectModelRole("slow", "openai/gpt-4o");
		expect(settings.getModelProfiles().work?.slow).toBe("openai/gpt-4o");
		expect(settings.getProjectModelRole("slow")).toBeUndefined();

		settings.clearProjectModelRole("slow");
		expect(settings.getModelProfiles().work?.slow).toBeUndefined();
	});

	it("fires the model-roles signal when the active profile changes", async () => {
		const settings = await init();
		const listener = vi.fn();
		const unsubscribe = onModelRolesChanged(listener);
		try {
			settings.setModelProfile("work", { default: "anthropic/claude-sonnet-4" });
			settings.setActiveModelProfile("work");
			expect(listener).toHaveBeenCalled();
			listener.mockClear();
			settings.setActiveModelProfile("work");
			expect(listener).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});

	it("deleting a profile deactivates it and restores base roles", async () => {
		const settings = await init();
		settings.set("modelRoles", { default: "openai/gpt-4o" });
		settings.setModelProfile("work", { default: "anthropic/claude-sonnet-4" });
		settings.setActiveModelProfile("work");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4");

		settings.deleteModelProfile("work");
		expect(settings.getActiveModelProfile()).toBe("");
		expect(settings.getModelRole("default")).toBe("openai/gpt-4o");
	});

	it("renaming keeps the profile active under the new name", async () => {
		const settings = await init();
		settings.setModelProfile("work", { default: "anthropic/claude-sonnet-4" });
		settings.setActiveModelProfile("work");

		settings.renameModelProfile("work", "prod");
		expect(settings.getActiveModelProfile()).toBe("prod");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4");
	});

	it("ignores activation of unknown profile names", async () => {
		const settings = await init();
		settings.setActiveModelProfile("nope");
		expect(settings.getActiveModelProfile()).toBe("");
	});

	it("persists profiles and the active profile to config.yml", async () => {
		const settings = await init();
		settings.setModelProfile("work", { default: "anthropic/claude-sonnet-4" });
		settings.setActiveModelProfile("work");
		await settings.flush();

		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as Record<string, unknown>;
		expect(saved.modelProfiles).toEqual({ work: { default: "anthropic/claude-sonnet-4" } });
		expect(saved.activeModelProfile).toBe("work");

		// A fresh instance restores the profile as the active role config.
		const reloaded = await init();
		expect(reloaded.getActiveModelProfile()).toBe("work");
		expect(reloaded.getModelRole("default")).toBe("anthropic/claude-sonnet-4");
	});

	it("sanitizes malformed profile entries read from config", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify(
				{
					modelProfiles: {
						work: { default: "anthropic/claude-sonnet-4", broken: null },
						broken: "not-a-record",
					},
				},
				null,
				2,
			),
		);
		const settings = await init();
		expect(settings.getModelProfiles()).toEqual({ work: { default: "anthropic/claude-sonnet-4" } });
	});
});
