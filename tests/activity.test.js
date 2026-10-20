import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { getToolActivity } from "../server/activity.ts";
import { getAgentActivity, approvalKey } from "../client/src/lib/activity.ts";
import { drawActivityIcon } from "../client/src/components/pixi/ActivityBubble.tsx";
import { ApprovalAlerts, playApprovalChime } from "../client/src/components/ApprovalAlerts.tsx";
import { AgentPanel } from "../client/src/components/AgentPanel.tsx";

test("provider and namespaced tools map to the four requested activities", () => {
  const groups = {
    writing: ["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "file_write", "apply_patch", "str_replace_editor"],
    reading: ["Read", "read_file", "view", "Glob", "Grep", "list_directory", "file_search", "mcp__filesystem__read_file"],
    research: ["WebSearch", "WebFetch", "web_search", "web_fetch", "browser_navigate", "mcp__browser__click", "research"],
    terminal: ["Bash", "terminal", "run_command", "execute_code", "shell", "powershell"],
  };
  for (const [activity, names] of Object.entries(groups)) {
    for (const name of names) assert.equal(getToolActivity(name), activity, name);
  }
  assert.equal(getToolActivity("todo"), null);
  assert.equal(getToolActivity(""), null);
});

test("activities persist for running tools, expire after completion, and yield to approvals", () => {
  const agent = { id: "agent", status: "working", activity: "terminal", toolName: "Bash" };
  assert.equal(getAgentActivity(agent, 99999999), "terminal");
  assert.equal(getAgentActivity({ ...agent, toolName: "", activityUntil: 1500 }, 1499), "terminal");
  assert.equal(getAgentActivity({ ...agent, toolName: "", activityUntil: 1500 }, 1500), null);
  for (const status of ["idle", "error"]) {
    assert.equal(getAgentActivity({ ...agent, status }, 100), null);
  }
  const waiting = { ...agent, status: "waiting", approvalRequestedAt: 10 };
  assert.equal(getAgentActivity(waiting, 99999999), "approval");
  assert.equal(approvalKey(waiting), approvalKey({ ...waiting, lastEventAt: 500 }));
  assert.notEqual(approvalKey(waiting), approvalKey({ ...waiting, approvalRequestedAt: 20 }));
  assert.notEqual(approvalKey({ ...waiting, approvalRequestId: "first" }),
    approvalKey({ ...waiting, approvalRequestId: "second" }));
});

const draw = (activity, time) => {
  const operations = [];
  const graphics = {};
  for (const method of ["lineStyle", "beginFill", "drawRect", "endFill", "drawCircle", "drawEllipse", "moveTo", "lineTo"]) {
    graphics[method] = (...args) => { operations.push([method, ...args]); return graphics; };
  }
  drawActivityIcon(graphics, activity, 0, 0, time);
  return operations;
};

test("each activity icon animates and approval has a stable red exclamation mark", () => {
  for (const activity of ["writing", "reading", "research", "terminal"]) {
    assert.notDeepEqual(draw(activity, 0), draw(activity, 160), activity);
  }
  const terminal = draw("terminal", 0);
  assert.ok(terminal.some(([method, color]) => method === "beginFill" && color === 0x4ade80));
  const approval = draw("approval", 0);
  assert.deepEqual(approval, draw("approval", 160));
  assert.ok(approval.some(([method, color]) => method === "beginFill" && color === 0xb91c1c));
  assert.equal(approval.filter(([method]) => method === "drawRect").length, 2);
});

test("approval controls default to silent and expose requests from every provider", () => {
  const agents = ["opencode", "claude", "hermes"].map((source) => ({
    id: source, source, alias: source, status: "waiting", approvalTool: "Bash",
  }));
  const html = renderToStaticMarkup(createElement(ApprovalAlerts, { agents, onSelectAgent: () => {} }));
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Approval chimes: off/);
  assert.match(html, /3 awaiting approval/);
  for (const { source } of agents) assert.ok(html.includes(`(${source})`));
  assert.match(html, /role="status"/);
});

test("the chime uses two quiet, bounded tones and disconnects completed audio nodes", () => {
  const tones = [];
  const context = {
    currentTime: 5, destination: {},
    createOscillator() {
      const tone = { frequency: {}, connect() {}, disconnect() { this.disconnected = true; },
        start(time) { this.startAt = time; }, stop(time) { this.stopAt = time; } };
      tones.push(tone);
      return tone;
    },
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime(value) { assert.ok(value <= 0.08); },
        exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    },
  };
  playApprovalChime(context);
  assert.deepEqual(tones.map((tone) => tone.frequency.value), [880, 1174]);
  for (const tone of tones) {
    assert.ok(tone.stopAt - tone.startAt <= 0.141);
    tone.onended();
    assert.equal(tone.disconnected, true);
  }
});

test("agent profiles identify helpers and display pending approval activity", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, {
    selectedAgent: {
      id: "helper", alias: "Tom", name: "research", role: "research",
      parentSessionId: "parent", status: "waiting", approvalTool: "Bash",
    }, sessions: [],
  }));
  assert.match(html, /Helper · research/);
  assert.match(html, /Awaiting approval/);
  assert.match(html, /Bash/);
  assert.match(html, /text-red-700/);
});
