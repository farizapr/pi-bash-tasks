// bash-tasks: every bash call gets a timeout; when it fires, the command is
// respawned detached and its output streams to a log. The model gets a steer
// message with the result when the process exits — Claude's run_in_background
// behavior, ported to pi.
//
// A task registry survives in ~/.pi/agent/tmp/bgtasks/ so bash_bg_status and
// bash_bg_kill can inspect and stop running work, and the footer status shows
// the running count via ctx.ui.setStatus.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BG_TIMEOUT_SECONDS = 60;
export const STATUS_KEY = "bash-tasks";
export const TAIL_BYTES = 64 * 1024;

export type TaskStatus = "running" | "exited" | "killed";

export interface BgTask {
	id: string;
	pid: number;
	command: string;
	cwd: string;
	logPath: string;
	startedAt: number;
	status: TaskStatus;
	exitCode?: number | null;
	proc?: ChildProcess;
}

const tasks = new Map<string, BgTask>();
const watchedCalls = new Map<string, { command: string; cwd: string }>();

export function taskDir(): string {
	return join(homedir(), ".pi", "agent", "tmp", "bgtasks");
}

function ensureDir(): string {
	const dir = taskDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function listTasks(): BgTask[] {
	return [...tasks.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function runningCount(): number {
	return listTasks().filter((t) => t.status === "running").length;
}

/**
 * Register a bash call so its tool_result can be recognised as a timeout.
 * Called from the tool_call handler; the caller applies the timeout itself.
 */
export function watchCall(toolCallId: string, command: string, cwd: string): void {
	watchedCalls.set(toolCallId, { command, cwd });
}

export function forgetCall(toolCallId: string): { command: string; cwd: string } | undefined {
	const call = watchedCalls.get(toolCallId);
	watchedCalls.delete(toolCallId);
	return call;
}

/** Is this tool_result the "timed out" shape pi's bash tool produces? */
export function isTimeoutResult(event: {
	isError: boolean;
	content: { type: string; text?: string }[];
}): boolean {
	if (!event.isError) return false;
	return event.content.some(
		(c) => c.type === "text" && /Command timed out after \d+ seconds/.test(c.text ?? ""),
	);
}

function readTail(path: string, maxBytes: number): string {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const len = Math.min(size, maxBytes);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

export interface SpawnHooks {
	notify?: (task: BgTask, outputTail: string) => void;
	onChange?: () => void;
}

/**
 * Respawn a command detached, streaming output to a log. Returns the task.
 * detached:true puts it in its own process group so a timed-out spawn cannot
 * be killed by pi's abort plumbing, and SIGTERM to -pid kills the group.
 */
export function spawnTask(command: string, cwd: string, hooks: SpawnHooks = {}): BgTask {
	const dir = ensureDir();
	const id = randomUUID().slice(0, 8);
	const logPath = join(dir, `${id}.log`);
	const outFd = openSync(logPath, "a");

	const proc = spawn("bash", ["-lc", command], {
		cwd,
		detached: true,
		stdio: ["ignore", outFd, outFd],
		env: { ...process.env, PI_BG_TASK_ID: id },
	});
	proc.unref();

	const task: BgTask = {
		id,
		pid: proc.pid ?? -1,
		command,
		cwd,
		logPath,
		startedAt: Date.now(),
		status: "running",
		proc,
	};
	tasks.set(id, task);
	hooks.onChange?.();

	proc.on("exit", (code, signal) => {
		closeSync(outFd);
		if (task.status === "running") task.status = "exited";
		task.exitCode =
			code ?? (signal ? 128 + (signal === "SIGTERM" ? 15 : signal === "SIGKILL" ? 9 : 0) : null);
		hooks.onChange?.();
		const tail = readTail(logPath, TAIL_BYTES);
		hooks.notify?.(task, tail);
	});

	return task;
}

export function killTask(id: string): boolean {
	const task = tasks.get(id);
	if (!task || task.status !== "running" || task.pid <= 0) return false;
	task.status = "killed";
	try {
		process.kill(-task.pid, "SIGTERM"); // kill the process group
	} catch {
		try {
			task.proc?.kill("SIGTERM");
		} catch {}
	}
	return true;
}

export function killAll(): number {
	let n = 0;
	for (const t of tasks.values()) {
		if (t.status === "running" && killTask(t.id)) n++;
	}
	return n;
}

export function taskOutput(id: string, bytes = TAIL_BYTES): string | null {
	const task = tasks.get(id);
	if (!task) return null;
	if (!existsSync(task.logPath)) return "";
	return readTail(task.logPath, bytes);
}
