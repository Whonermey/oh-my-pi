import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1); Mnemopi only"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate; Mnemopi only"),
	"reason?": type("string").describe("optional free-text reason recorded when invalidating (Hindsight)"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "Memory Edit";
	readonly description = memoryEditDescription;
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate Mnemopi memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mnemopi" && backend !== "hindsight") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		const backend = this.session.settings.get("memory.backend");
		if (backend === "mnemopi") {
			return this.#executeMnemopi(params);
		}
		return this.#executeHindsight(params);
	}

	async #executeMnemopi(params: MemoryEditParams): Promise<AgentToolResult> {
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `Memory ${params.id} was not found${location}.`
				: result.status === "not_editable"
					? `Memory ${params.id} is a read-only fact${location}; it cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}${location}.`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}

	async #executeHindsight(params: MemoryEditParams): Promise<AgentToolResult> {
		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}
		// Hindsight exposes curation (PATCH), not hard delete. `forget` maps to
		// the closest supported semantic: soft-retire, excluded from recall and
		// reversible via update op with state=valid — never silently dropped.
		if (params.op === "forget") {
			return {
				content: [
					{
						type: "text",
						text: "Hindsight has no hard delete. Use op=invalidate to soft-retire the memory (excluded from recall; reversible). Read it first with memory://<id> if you need the full content.",
					},
				],
				details: { backend: "hindsight", op: params.op },
			};
		}
		if (params.op === "update" && params.content === undefined) {
			throw new Error("memory_edit update requires content for Hindsight.");
		}

		const curation =
			params.op === "invalidate"
				? { state: "invalidated" as const, reason: params.reason }
				: { text: params.content };
		try {
			await state.client.curateMemory(state.bankId, params.id, curation);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/404/i.test(message)) {
				return {
					content: [{ type: "text", text: `Memory ${params.id} was not found.` }],
					details: { backend: "hindsight", op: params.op, status: "not_found" },
				};
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
		const verb = params.op === "update" ? "updated (re-embedded)" : "invalidated (excluded from recall)";
		return {
			content: [{ type: "text", text: `Memory ${params.id} ${verb}.` }],
			details: { backend: "hindsight", bankId: state.bankId, op: params.op, id: params.id },
		};
	}
}
