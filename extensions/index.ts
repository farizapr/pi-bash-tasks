// bash-tasks: Claude's run_in_background for pi.
//
// Every bash call gets PI_BASH_BG_TIMEOUT seconds (default 60). When the call
// still runs past it, the command is respawned detached, its output streams to
// ~/.pi/agent/tmp/bgtasks/<id>.log, and the tool result is rewritten to a
// "moved to background" notice. The model is woken with the output tail as a
// steer message when the process exits — no polling loop, no blocked turn.
//
// `bash_bg_status` lists tasks, `bash_bg_kill` stops one, `bash_bg_start`
// launches one directly. The footer status shows ⏳<n> while any are running,
// and `/bg-list` shows the same list as a slash command.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BG_TIMEOUT_SECONDS,
	STATUS_KEY,
	TAIL_BYTES,
	forgetCall,
	isTimeoutResult,
	killAll,
	killTask,
	listTasks,
	runningCount,
	spawnTask,
	taskOutput,
	watchCall,
} from "./tasks.ts";

const STALE_CTX_RE = /ctx is stale/;

function statusText(count: number): string | undefined {
	return count > 0 ? `⏳ ${count} bg` : undefined;
}

export default function bashTasks(pi: ExtensionAPI) {
	const fromEnv = Number(process.env.PI_BASH_BG_TIMEOUT);
	const timeout =
		Number.isFinite(fromEnv) && process.env.PI_BASH_BG_TIMEOUT !== ""
			? fromEnv
			: BG_TIMEOUT_SECONDS;
	let ctxRef: { cwd: string; ui?: { setStatus(k: string, t?: string): void; notify?(m: string, t?: string): void } } | null = null;
	let sessionAlive = true;

	/**
	 * pi invalidates a captured ctx — and this instance's `pi` — when the session is reloaded or
	 * replaced, and touching either afterwards throws. Background-task callbacks are async and
	 * outlive the session that spawned them (session_shutdown kills every task, so the exit fires
	 * right after a reload), and a throw inside a child-process listener is an uncaughtException
	 * that takes pi down with it. A stale throw therefore means this instance lost its session:
	 * drop the reference and stop using it. Any other error is a real bug and still propagates.
	 */
	function withSession(fn: () => void): void {
		if (!sessionAlive) return;
		try {
			fn();
		} catch (error) {
			if (!(error instanceof Error && STALE_CTX_RE.test(error.message))) throw error;
			sessionAlive = false;
			ctxRef = null;
		}
	}

	function refreshStatus() {
		withSession(() => ctxRef?.ui?.setStatus(STATUS_KEY, statusText(runningCount())));
	}

	function notifyTaskDone(task: { id: string; command: string; status: string; exitCode?: number | null }, tail: string) {
		const outcome = task.status === "killed" ? "killed" : `exit ${task.exitCode ?? "?"}`;
		const body =
			`Background task ${task.id} finished (${outcome}).\n` +
			`Command: ${task.command}\n\n` +
			(tail ? `Output tail:\n${tail}` : "(no output)");
		withSession(() => {
			pi.sendMessage(
				{ customType: "bash-bg", content: body, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	// ── bash call lifecycle ────────────────────────────────────────────

	pi.on("session_start", (_e, ctx) => {
		ctxRef = ctx as typeof ctxRef;
		sessionAlive = true;
		refreshStatus();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		if (timeout <= 0) return;
		const input = event.input as { command?: string; timeout?: number };
		if (typeof input.command !== "string" || !input.command.trim()) return;
		// Cap foreground wait at the bg threshold even when the model set a
		// larger timeout — a long timeout is not a license to block the turn.
		const modelTimeout = input.timeout;
		input.timeout = timeout;
		watchCall(event.toolCallId, input.command, ctx.cwd, modelTimeout);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const call = forgetCall(event.toolCallId);
		if (!call || !isTimeoutResult(event)) return;

		const task = spawnTask(call.command, call.cwd, {
			notify: notifyTaskDone,
			onChange: refreshStatus,
			// Honour the model's larger timeout as the background task's cap.
			timeoutSeconds: call.killAfter,
		});
		refreshStatus();
		ctx.ui.notify(`⏳ background task ${task.id} (pid ${task.pid})`, "info");

		event.isError = false;
		event.content = [
			{
				type: "text",
				text:
					`Command exceeded the ${timeout}s foreground limit and was moved to background ` +
					`task ${task.id} (pid ${task.pid}). Output streams to ${task.logPath}. ` +
					`You will be notified when it exits; call bash_bg_status to peek or ` +
					`bash_bg_kill to stop it. Do not poll the log with sleep loops.`,
			},
		];
	});

	// ── slash commands ─────────────────────────────────────────────────

	pi.registerCommand("bg-list", {
		description: "List background bash tasks with status, pid, and log path",
		handler: async (_args, ctx) => {
			const tasks = listTasks();
			if (tasks.length === 0) {
				ctx.ui.notify("No background tasks.", "info");
				return;
			}
			const rows = tasks.map(
				(t) =>
					`${t.id} [${t.status}${t.exitCode != null ? `:${t.exitCode}` : ""}] pid=${t.pid} ` +
					`elapsed=${Math.round((Date.now() - t.startedAt) / 1000)}s\n  ${t.command}\n  log: ${t.logPath}`,
			);
			ctx.ui.notify(rows.join("\n\n"), "info");
		},
	});

	// ── model tools ────────────────────────────────────────────────────

	pi.registerTool({
		name: "bash_bg_status",
		label: "Background bash tasks",
		description:
			"List background bash tasks (moved there after exceeding the foreground timeout), with their status, pid, and output log path. Optionally read the tail of one task's log.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Task id to read output from" })),
			bytes: Type.Optional(
				Type.Number({ description: `Log tail bytes to read (default ${TAIL_BYTES})` }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const tasks = listTasks();
			const rows = tasks.map(
				(t) =>
					`${t.id} [${t.status}${t.exitCode != null ? `:${t.exitCode}` : ""}] pid=${t.pid} ` +
					`elapsed=${Math.round((Date.now() - t.startedAt) / 1000)}s log=${t.logPath}\n  ${t.command}`,
			);
			let text = rows.length ? rows.join("\n") : "No background tasks.";
			if (params.id) {
				const out = taskOutput(params.id, params.bytes ?? TAIL_BYTES);
				text += out === null ? `\n\nUnknown task ${params.id}` : `\n\n--- ${params.id} output ---\n${out || "(empty)"}`;
			}
			return {
				content: [{ type: "text", text }],
				details: {
					tasks: tasks.map(({ proc, ...t }) => t),
					count: tasks.length,
					running: runningCount(),
				},
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_start",
		label: "Start background bash task",
		description:
			"Start a bash command in the background. Returns a task id and log path immediately; the agent is notified when it exits. Use for long-running commands (builds, installs, test suites, servers) where the foreground timeout would kill the command.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Maximum seconds before killing (default: none)" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const task = spawnTask(params.command, ctx.cwd, {
				notify: notifyTaskDone,
				onChange: refreshStatus,
			});
			refreshStatus();

			if (params.timeout !== undefined) {
				setTimeout(() => {
					if (task.status === "running") killTask(task.id);
				}, params.timeout * 1000).unref();
			}

			return {
				content: [
					{
						type: "text",
						text: `Background task ${task.id} started (pid ${task.pid}). Output: ${task.logPath}. You will be notified when it exits; bash_bg_status peeks, bash_bg_kill stops.`,
					},
				],
				details: { task: { ...task, proc: undefined } },
			};
		},
	});

	pi.registerTool({
		name: "bash_bg_kill",
		label: "Kill background bash task",
		description: "Kill a running background bash task and its process group.",
		parameters: Type.Object({
			id: Type.String({ description: "Task id from bash_bg_status or the moved-to-background notice" }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const ok = killTask(params.id);
			refreshStatus();
			return {
				content: [
					{
						type: "text",
						text: ok ? `Killed task ${params.id}` : `No running task ${params.id}`,
					},
				],
				details: { killed: ok, id: params.id },
				isError: !ok,
			};
		},
	});

	// ── cleanup ────────────────────────────────────────────────────────

	pi.on("session_shutdown", () => {
		killAll();
		withSession(() => ctxRef?.ui?.setStatus(STATUS_KEY, undefined));
	});
}
