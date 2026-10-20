import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";

const SESSION_NAMES = [
  "Tom", "Jerry", "Jack", "Oliver", "Henry", "Leo", "Max", "Sam",
  "Ben", "Emma", "Lucy", "Lily", "Alice", "Grace", "Ruby",
];

const startServer = async (t, config = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-office-server-"));
  const configDir = path.join(home, ".opencode/pixel-office");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOME: home, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    fs.rmSync(home, { recursive: true, force: true });
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
  const post = async (event) => {
    const response = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    assert.equal(response.status, 202);
    return snapshot();
  };
  const send = (type, sid, extra = {}, source = "hermes") => post({
    source, type,
    properties: {
      sessionID: sid,
      info: { id: sid, sessionID: sid, agent: source === "hermes" ? "Hermes" : source },
      ...extra,
    },
  });
  return { send, snapshot, base, post };
};

test("tool animations track activity, concurrent calls, and completion for every provider", async (t) => {
  const { send } = await startServer(t);
  for (const source of ["opencode", "claude", "hermes"]) {
    const sid = `activity-${source}`;
    let state = await send("session.created", sid, {}, source);
    const id = state.agents.find((agent) => agent.source === source).id;
    const agent = (state) => state.agents.find((a) => a.id === id);
    for (const [name, activity] of [["Write", "writing"], ["Read", "reading"], ["WebSearch", "research"], ["Bash", "terminal"]]) {
      state = await send("tool.execute.before", sid, { tool: { id: name, name } }, source);
      assert.equal(agent(state).activity, activity);
      assert.equal(agent(state).toolName, name);
      state = await send("tool.execute.after", sid, { tool: { id: name, name } }, source);
      assert.equal(agent(state).toolName, "");
      assert.equal(agent(state).activity, activity);
      assert.ok(agent(state).activityUntil > Date.now());
    }
    await send("tool.execute.before", sid, { tool: { id: "one", name: "Read" } }, source);
    await send("tool.execute.before", sid, { tool: { id: "two", name: "Bash" } }, source);
    state = await send("tool.execute.after", sid, { tool: { id: "one", name: "Read" } }, source);
    assert.equal(agent(state).activity, "terminal");
    assert.equal(agent(state).toolName, "Bash");
    state = await send("session.idle", sid, {}, source);
    assert.equal(agent(state).activity, null);
  }
});

test("native OpenCode tool parts and permission payloads update the correct session", async (t) => {
  const { send, post } = await startServer(t);
  await send("session.created", "ses_native", {}, "opencode");
  const part = { type: "tool", sessionID: "ses_native", callID: "call-1", tool: "bash" };
  let state = await post({ type: "message.part.updated", properties: { part: { ...part, state: { status: "running" } } } });
  const agent = () => state.agents.find((a) => a.sessionId === "ses_native");
  assert.equal(agent().activity, "terminal");
  state = await post({ type: "permission.asked", properties: { sessionID: "ses_native", id: "approval-1", permission: "bash" } });
  assert.equal(agent().status, "waiting");
  assert.equal(agent().approvalTool, "bash");
  const approvalAt = agent().approvalRequestedAt;
  state = await post({ type: "message.part.updated", properties: { part: { ...part, state: { status: "running" } } } });
  assert.equal(agent().status, "waiting");
  assert.equal(agent().approvalRequestedAt, approvalAt);
  state = await post({ type: "permission.replied", properties: { sessionID: "ses_native", requestID: "approval-1" } });
  assert.notEqual(agent().status, "waiting");
  state = await post({ type: "message.part.updated", properties: { part: { ...part, state: { status: "completed" } } } });
  assert.equal(agent().toolName, "");
  assert.equal(agent().status, "thinking");
});

test("replying to one approval does not clear other pending requests", async (t) => {
  const { send } = await startServer(t);
  const sid = "parallel-approvals";
  await send("session.created", sid);
  let state = await send("permission.asked", sid, { id: "first", permission: { tool: "terminal" } });
  const firstTimestamp = state.agents[0].approvalRequestedAt;
  state = await send("permission.asked", sid, { id: "second", permission: { tool: "write_file" } });
  assert.equal(state.agents[0].approvalTool, "write_file");
  state = await send("permission.replied", sid, { requestID: "second" });
  assert.equal(state.agents[0].status, "waiting");
  assert.equal(state.agents[0].approvalTool, "terminal");
  assert.equal(state.agents[0].approvalRequestedAt, firstTimestamp);
  state = await send("permission.replied", sid, { requestID: "first" });
  assert.equal(state.agents[0].status, "thinking");
});

test("a tool completion clears only its own approval when commands run concurrently", async (t) => {
  const { send } = await startServer(t);
  const sid = "concurrent-commands";
  for (const id of ["first", "second"]) {
    await send("tool.execute.before", sid, { tool: { id, name: "Bash" } });
    await send("permission.asked", sid, {
      id: `approval-${id}`, permission: { tool: "Bash" }, tool: { id, name: "Bash" },
    });
  }
  let state = await send("tool.execute.after", sid, { tool: { id: "first", name: "Bash" } });
  assert.equal(state.agents[0].status, "waiting");
  assert.equal(state.agents[0].approvalRequestId, "approval-second");
  assert.equal(state.agents[0].toolName, "Bash");
  state = await send("tool.execute.after", sid, { tool: { id: "second", name: "Bash" } });
  assert.equal(state.agents[0].status, "thinking");
  assert.equal(state.agents[0].approvalRequestedAt, 0);
});

test("running tools and pending approvals do not expire after the idle timeout", async (t) => {
  const { send, snapshot } = await startServer(t);
  for (const source of ["opencode", "claude", "hermes"]) {
    await send("tool.execute.before", `${source}-long`, { tool: { name: "Bash" } }, source);
    await send("tool.execute.before", `${source}-approval`, { tool: { name: "Bash" } }, source);
    await send("permission.asked", `${source}-approval`, { permission: { tool: "Bash" } }, source);
  }
  await delay(6200);
  let state = await snapshot();
  assert.equal(state.agents.filter((agent) => agent.status === "waiting").length, 3);
  assert.equal(state.agents.filter((agent) => agent.status === "working").length, 3);
  for (const source of ["opencode", "claude", "hermes"]) {
    state = await send("message.updated", `${source}-approval`, {}, source);
    const waiting = state.agents.find((agent) => agent.source === source && agent.status === "waiting");
    assert.ok(waiting);
    const timestamp = waiting.approvalRequestedAt;
    state = await send("permission.asked", `${source}-approval`, { permission: { tool: "Bash" } }, source);
    assert.equal(state.agents.find((agent) => agent.id === waiting.id).approvalRequestedAt, timestamp);
    state = await send("tool.execute.after", `${source}-approval`, { tool: { name: "Bash" }, status: "error" }, source);
    assert.equal(state.agents.find((agent) => agent.id === waiting.id).status, "error");
  }
});

test("Hermes thinking status remains authoritative beyond the generic idle timeout", async (t) => {
  const { send, snapshot } = await startServer(t);
  await send("session.created", "long-response");
  await send("session.updated", "long-response", { status: "thinking" });
  await delay(6200);
  let state = await snapshot();
  assert.equal(state.agents[0].status, "thinking");
  assert.equal(state.sessions[0].status, "thinking");
  state = await send("session.idle", "long-response");
  assert.equal(state.agents[0].status, "idle");
  assert.equal(state.sessions[0].status, "idle");
});

test("Hermes profile discovery and identical session IDs remain isolated by profile", async (t) => {
  const { post, base } = await startServer(t);
  const discovery = await post({
    source: "hermes", type: "hermes.profiles",
    properties: { profiles: ["default", "dev-team", "research", "dev-team"] },
  });
  assert.equal(discovery.hermesDefaultProfile, "dev-team");
  assert.deepEqual(new Set(discovery.hermesProfiles), new Set(["default", "dev-team", "research"]));
  const sendProfile = (type, profile, extra = {}) => post({
    source: "hermes", type,
    properties: {
      sessionID: "same", info: { id: "same", sessionID: "same", profile },
      ...extra,
    },
  });
  await sendProfile("session.created", "dev-team");
  let state = await sendProfile("permission.asked", "research");
  assert.equal(state.agents.length, 2);
  assert.equal(state.agents.find((a) => a.profile === "dev-team").status, "idle");
  assert.equal(state.agents.find((a) => a.profile === "research").status, "waiting");
  const ambiguous = await fetch(`${base}/events`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "hermes", type: "session.updated", properties: { sessionID: "same" } }),
  });
  assert.equal(ambiguous.status, 400);
  state = await sendProfile("session.created", "research", { sessionID: "child", parentSessionId: "same" });
  const parent = state.agents.find((a) => a.profile === "research" && a.sessionId.endsWith(":same"));
  assert.equal(state.agents.find((a) => a.sessionId.endsWith(":child")).parentSessionId, parent.sessionId);
  state = await sendProfile("session.deleted", "dev-team");
  assert.equal(state.agents.length, 2);
  assert.ok(state.agents.every((a) => a.profile === "research"));
  for (const properties of [{ profiles: ["../bad"] }, { profiles: "dev-team" }]) {
    const response = await fetch(`${base}/events`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "hermes", type: "hermes.profiles", properties }),
    });
    assert.equal(response.status, 400);
  }
});

test("Hermes dashboard default uses the explicitly installed profile", async (t) => {
  const { snapshot } = await startServer(t, { hermesProfile: "research" });
  const state = await snapshot();
  assert.equal(state.hermesDefaultProfile, "research");
  assert.ok(state.hermesProfiles.includes("research"));
});

test("Claude hooks create independent helpers and clear approval on tool completion", async (t) => {
  const { base, snapshot } = await startServer(t);
  const hook = async (hook_event_name, extra = {}) => {
    const child = spawn(process.execPath, ["bin/claude-code-hook.js"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PIXEL_OFFICE_URL: `${base}/events` },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (data) => { error += data; });
    child.stdin.end(JSON.stringify({ hook_event_name, session_id: "claude-main", cwd: "/work/repo", ...extra }));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, error);
    return snapshot();
  };
  let state = await hook("SessionStart");
  const parent = state.agents[0];
  state = await hook("SubagentStart", { agent_id: "helper-1", agent_type: "research" });
  const helper = state.agents.find((agent) => agent.parentSessionId);
  assert.ok(helper);
  assert.equal(helper.parentSessionId, parent.sessionId);
  assert.equal(helper.name, "research");
  assert.equal(helper.role, "research");
  assert.notEqual(helper.alias, parent.alias);
  state = await hook("PreToolUse", { tool_name: "Bash", tool_use_id: "parent-command" });
  assert.equal(state.agents.find((agent) => agent.id === helper.id).toolName, "");
  state = await hook("PreToolUse", { agent_id: "helper-1", agent_type: "research", tool_name: "WebSearch", tool_use_id: "search" });
  assert.equal(state.agents.find((agent) => agent.id === helper.id).activity, "research");
  assert.equal(state.agents.find((agent) => agent.id === parent.id).activity, "terminal");
  state = await hook("PermissionRequest", { tool_name: "Bash" });
  assert.equal(state.agents.find((agent) => agent.id === parent.id).status, "waiting");
  const approvalAt = state.agents.find((agent) => agent.id === parent.id).approvalRequestedAt;
  state = await hook("Notification", { notification_type: "permission_prompt" });
  assert.equal(state.agents.find((agent) => agent.id === parent.id).approvalRequestedAt, approvalAt);
  state = await hook("PostToolUse", { tool_name: "Bash", tool_use_id: "parent-command" });
  assert.equal(state.agents.find((agent) => agent.id === parent.id).status, "thinking");
  state = await hook("SubagentStop", { agent_id: "helper-1", agent_type: "research" });
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].id, parent.id);
  assert.equal(state.sessions.length, 1);
  state = await hook("SessionEnd");
  assert.equal(state.agents.length, 0);
});

test("OpenCode parent metadata marks helpers without changing their parent agent", async (t) => {
  const { send, post } = await startServer(t);
  await send("session.created", "oc-parent", {}, "opencode");
  await post({ type: "session.created", properties: { info: { id: "oc-child", parentID: "oc-parent" } } });
  let state = await post({ type: "message.updated", properties: { info: { id: "msg", sessionID: "oc-child", agent: "explore" } } });
  const helper = state.agents.find((agent) => agent.sessionId === "oc-child");
  assert.equal(helper.parentSessionId, "oc-parent");
  assert.ok(state.interactions.length);
  state = await send("session.deleted", "oc-parent", {}, "opencode");
  assert.equal(state.agents.length, 0);
  assert.equal(state.sessions.length, 0);
});

test("Hermes lifecycle is isolated, visible immediately, and cleaned up completely", async (t) => {
  const { send, snapshot, base } = await startServer(t);
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
  const childName = agent(state, "child").alias;
  assert.ok(SESSION_NAMES.includes(childName));
  assert.notEqual(childName, agent(state, "same").alias);
  assert.equal(agent(state, "child").name, "research");
  assert.equal(agent(state, "child").role, "research");
  assert.ok(state.interactions.some((i) =>
    i.from === agent(state, "same").id && i.to === agent(state, "child").id));
  state = await send("tool.execute.before", "child", {
    info: { id: "child", sessionID: "child", agent: "changed role" },
  });
  assert.equal(state.agents.filter((a) => a.sessionId === "hermes:child").length, 1);
  assert.equal(agent(state, "child").alias, childName);
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

test("Hermes metadata survives sparse events and quests belong to their session", async (t) => {
  const { send } = await startServer(t);
  const sid = "session-abcdef";
  const session = (state, id) => state.sessions.find((s) =>
    s.id === `hermes:dev-team:${id}` || s.id === `hermes:${id}`);
  let state = await send("session.created", sid, {
    info: {
      id: sid, sessionID: sid, agent: "dev-team", profile: "dev-team",
      directory: "/work/repo", title: "Fix metadata",
      model: { modelID: "test-model", providerID: "openrouter" },
    },
  });
  let agent = state.agents[0];
  const displayName = agent.alias;
  assert.ok(SESSION_NAMES.includes(displayName));
  assert.equal(agent.name, "dev-team");
  assert.equal(session(state, sid).displayName, displayName);
  assert.equal(agent.profile, "dev-team");
  assert.equal(agent.model, "test-model");
  assert.equal(agent.provider, "openrouter");
  assert.equal(agent.sessionId, `hermes:dev-team:${sid}`);
  assert.equal(session(state, sid).source, "hermes");

  state = await send("session.updated", sid, {
    info: { id: sid, sessionID: sid }, status: "thinking",
  });
  agent = state.agents[0];
  assert.equal(agent.alias, displayName);
  assert.equal(session(state, sid).displayName, displayName);
  assert.equal(agent.model, "test-model");
  assert.equal(agent.provider, "openrouter");
  assert.equal(session(state, sid).directory, "/work/repo");
  assert.equal(session(state, sid).title, "Fix metadata");
  assert.equal(session(state, sid).profile, "dev-team");
  assert.equal(session(state, sid).status, "thinking");

  const todos = [
    { id: "1", content: "Investigate", status: "completed" },
    { id: "2", content: "Fix mapping", status: "in_progress" },
    { id: "3", content: "Discard", status: "cancelled" },
  ];
  state = await send("todo.updated", sid, { todos });
  assert.equal(session(state, sid).todos.length, 3);
  assert.equal(session(state, sid).lastTodoSummary.completed, 1);
  assert.equal(session(state, sid).lastTodoSummary.total, 3);
  assert.equal(session(state, sid).status, "thinking");
  assert.equal(state.agents[0].status, "thinking");
  assert.deepEqual(state.todos, []);

  state = await send("todo.updated", "other", {
    todos: [{ id: "1", content: "Other session", status: "pending" }],
  });
  assert.equal(session(state, sid).todos[0].content, "Investigate");
  assert.equal(session(state, "other").todos[0].content, "Other session");
  state = await send("todo.updated", "oc-session", {
    todos: [{ id: "1", content: "OpenCode task", status: "pending" }],
  }, "opencode");
  assert.equal(state.todos[0].content, "OpenCode task");
  assert.equal(state.sessions.find((s) => s.id === "oc-session").source, "opencode");
  assert.equal(session(state, sid).todos[0].content, "Investigate");

  state = await send("todo.updated", sid, {
    todos: [{ id: "1", content: "Done", status: "completed" }],
  });
  assert.equal(session(state, sid).todos.length, 1);
  assert.equal(session(state, sid).lastTodoSummary.completed, 1);
  assert.equal(session(state, sid).lastTodoSummary.total, 1);
  state = await send("session.deleted", sid);
  assert.equal(session(state, sid), undefined);
  assert.equal(session(state, "other").todos[0].content, "Other session");
});

test("sessions use 15 unique English names, keep them on updates, and reuse released names", async (t) => {
  const { send, snapshot } = await startServer(t);
  const sources = ["hermes", "opencode", "claude"];
  const assignedNames = new Map();
  let state;
  for (let index = 0; index < 15; index++) {
    const source = sources[index % sources.length];
    const sid = `named-${index}`;
    await send("session.created", sid, {}, source);
    state = await send("tool.execute.before", sid, {}, source);
    const sessionId = source === "hermes" ? `hermes:${sid}` : sid;
    const agent = state.agents.find((a) => a.sessionId === sessionId);
    assert.ok(SESSION_NAMES.includes(agent.alias));
    assignedNames.set(sessionId, agent.alias);
    assert.equal(state.sessions.find((s) => s.id === sessionId).displayName, agent.alias);
  }
  assert.equal(new Set(assignedNames.values()).size, 15);
  assert.deepEqual(new Set(assignedNames.values()), new Set(SESSION_NAMES));

  for (let index = 0; index < sources.length; index++) {
    const sid = `named-${index}`;
    await send("session.updated", sid, {}, sources[index]);
    await send("tool.execute.before", sid, {
      info: { id: sid, sessionID: sid, agent: "renamed-profile" },
    }, sources[index]);
  }
  state = await snapshot();
  for (const [sessionId, name] of assignedNames) {
    assert.equal(state.agents.find((a) => a.sessionId === sessionId).alias, name);
    assert.equal(state.sessions.find((s) => s.id === sessionId).displayName, name);
  }

  state = await send("session.created", "overflow");
  const overflow = state.agents.find((a) => a.sessionId === "hermes:overflow");
  assert.match(overflow.alias, / 2$/);
  assert.ok(SESSION_NAMES.includes(overflow.alias.slice(0, -2)));
  assert.equal(new Set(state.agents.map((a) => a.alias)).size, 16);
  assert.equal(state.sessions.find((s) => s.id === "hermes:overflow").displayName, overflow.alias);

  const releasedName = assignedNames.get("hermes:named-0");
  state = await send("session.deleted", "named-0");
  assert.ok(!state.agents.some((a) => a.alias === releasedName));
  state = await send("session.created", "replacement");
  assert.equal(state.agents.find((a) => a.sessionId === "hermes:replacement").alias, releasedName);
  assert.equal(state.agents.find((a) => a.sessionId === "hermes:overflow").alias, overflow.alias);
});
