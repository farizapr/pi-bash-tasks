import { test } from "node:test";
import assert from "node:assert/strict";
import { isTimeoutResult, spawnTask, killTask, listTasks, runningCount, taskOutput } from "./tasks.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("isTimeoutResult matches the bash tool's timeout shape", () => {
  assert.ok(
    isTimeoutResult({
      isError: true,
      content: [{ type: "text", text: "Command timed out after 60 seconds" }],
    }),
  );
  assert.ok(
    !isTimeoutResult({ isError: true, content: [{ type: "text", text: "exit 1" }] }),
  );
  assert.ok(
    !isTimeoutResult({ isError: false, content: [{ type: "text", text: "Command timed out after 60 seconds" }] }),
  );
});

test("spawnTask runs a command to a log and reports exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bgt-"));
  let notified: { status: string; tail: string } | null = null;
  const task = spawnTask("echo hello-bg; sleep 0.1; echo done", dir, {
    notify: (t, tail) => (notified = { status: t.status, tail }),
  });
  assert.equal(task.status, "running");
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(notified, "notify hook fired");
  assert.equal(notified!.status, "exited");
  assert.ok(notified!.tail.includes("hello-bg") && notified!.tail.includes("done"));
});

test("killTask stops a running task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bgt-"));
  const task = spawnTask("sleep 60", dir);
  assert.equal(runningCount(), listTasks().filter((t) => t.status === "running").length);
  assert.ok(killTask(task.id));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(task.status, "killed");
  assert.ok(!killTask(task.id));
});

test("taskOutput reads the log tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bgt-"));
  const task = spawnTask("echo tail-line", dir);
  await new Promise((r) => setTimeout(r, 800));
  assert.match(taskOutput(task.id) ?? "", /tail-line/);
  assert.equal(taskOutput("nonexistent"), null);
});
