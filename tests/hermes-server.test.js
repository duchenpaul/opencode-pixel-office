import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";

test("Hermes lifecycle is isolated, visible immediately, and cleaned up completely", async (t) => {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  });
  // The server prints the actual bound port when PORT=0.
  for (let attempt = 0; !output.match(/Local:.*:(\d+)/) && attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(output);
    await delay(50);
  }
  const port = output.match(/Local:.*:(\d+)/)?.[1];
  assert.ok(port && port !== "0", output);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const snapshot = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      const [raw] = await once(socket, "message");
      return JSON.parse(raw.toString()).state;
    } finally {
      socket.close();
    }
  };
  const send = async (type, sid, extra = {}, source = "hermes") => {
    const response = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source, type,
        properties: {
          sessionID: sid,
          info: { id: sid, sessionID: sid, agent: source === "hermes" ? "Hermes" : source },
          ...extra,
        },
      }),
    });
    assert.equal(response.status, 202);
    return snapshot();
  };
  const agent = (state, sid) => state.agents.find((a) => a.sessionId === `hermes:${sid}`);
  let state = await send("session.created", "same");
  assert.equal(agent(state, "same").status, "idle");
  assert.equal(state.sessions.length, 1);
  state = await send("tool.execute.before", "same", { tool: { name: "terminal" } });
  assert.equal(agent(state, "same").status, "working");
  await send("tool.execute.before", "same", {}, "opencode");
  state = await send("tool.execute.before", "claude-session", {}, "claude");
  assert.deepEqual(new Set(state.agents.map((a) => a.source)), new Set(["hermes", "opencode", "claude"]));
  state = await send("session.created", "claude-session");
  assert.equal(state.agents.length, 4);
  await send("session.deleted", "claude-session");

  state = await send("session.created", "child", {
    parentSessionId: "same", status: "working",
    info: { id: "child", sessionID: "child", agent: "research", role: "research" },
  });
  assert.equal(agent(state, "child").alias, "research");
  assert.equal(agent(state, "child").role, "research");
  assert.ok(state.interactions.some((i) =>
    i.from === agent(state, "same").id && i.to === agent(state, "child").id));
  state = await send("tool.execute.before", "child", {
    info: { id: "child", sessionID: "child", agent: "changed role" },
  });
  assert.equal(state.agents.filter((a) => a.sessionId === "hermes:child").length, 1);
  state = await send("permission.asked", "same", { preview: "Awaiting approval" });
  assert.equal(agent(state, "same").status, "waiting");
  await delay(6200);
  state = await snapshot();
  assert.equal(agent(state, "same").status, "waiting");
  state = await send("permission.replied", "same");
  assert.equal(agent(state, "same").status, "thinking");
  state = await send("tool.execute.after", "same", { status: "error", preview: "failed" });
  assert.equal(agent(state, "same").status, "error");
  assert.equal(agent(state, "same").lastMessageSnippet, "failed");
  state = await send("tool.execute.before", "same");
  assert.equal(agent(state, "same").status, "working");
  state = await send("tool.execute.after", "same", { status: "thinking" });
  assert.equal(agent(state, "same").status, "thinking");

  state = await send("session.deleted", "child");
  assert.equal(agent(state, "child"), undefined);
  assert.equal(state.interactions.length, 0);
  await send("session.created", "child2", { parentSessionId: "same" });
  await send("session.created", "grandchild", { parentSessionId: "child2" });
  state = await send("session.deleted", "same");
  assert.equal(state.agents.filter((a) => a.source === "hermes").length, 0);
  assert.equal(state.sessions.filter((s) => s.id.startsWith("hermes:")).length, 0);
  assert.equal(state.interactions.length, 0);
  assert.equal(state.agents.length, 2);
  assert.equal(state.activeSessionId, null);

  state = await send("tool.execute.before", "late-attach");
  assert.ok(agent(state, "late-attach"));
  assert.ok(state.sessions.some((s) => s.id === "hermes:late-attach"));
  const invalid = await fetch(`${base}/events`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "hermes", type: "session.created" }),
  });
  assert.equal(invalid.status, 400);
});
