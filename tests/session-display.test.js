import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { AgentPanel } from "../client/src/components/AgentPanel.tsx";
import { SessionPanel } from "../client/src/components/SessionPanel.tsx";
import { TodoPanel } from "../client/src/components/TodoPanel.tsx";
import { formatSessionName, getSessionDisplayId } from "../client/src/lib/session.ts";

const session = {
  id: "hermes:20261020-abcdef", source: "hermes",
  profile: "dev-team", directory: "/work/repo",
};

test("session labels shorten the actual ID, not the source namespace", () => {
  assert.equal(getSessionDisplayId(session.id), "20261020-abcdef");
  assert.equal(getSessionDisplayId("hermes:session%2Fchild"), "session/child");
  assert.equal(formatSessionName(session), "repo · 202610");
  assert.equal(formatSessionName({ id: "hermes:other-abcdef" }), "other-");
  assert.equal(formatSessionName({ id: "ses_abcdef", title: "OpenCode" }), "OpenCode · ses_ab");
  assert.equal(formatSessionName({ id: "hermes:12345678", profile: "dev-team" }), "dev-team · 123456");
});

test("session labels use the assigned English name while retaining repository context", () => {
  assert.equal(formatSessionName({ ...session, displayName: "Tom" }), "Tom · repo");
  assert.equal(formatSessionName({ id: "ses_other", displayName: "Jerry" }), "Jerry");
  assert.equal(formatSessionName({ ...session, displayName: "Tom 2" }), "Tom 2 · repo");
});

test("profile and session panels render runtime metadata and real session IDs", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, {
    selectedAgent: {
      id: `${session.id}:agent`, source: "hermes", alias: "dev-team",
      profile: "dev-team", sessionId: session.id, model: "test-model",
      provider: "openrouter", status: "thinking",
    },
    sessions: [session],
  }));
  assert.match(html, /dev-team · repo/);
  assert.match(html, /test-model/);
  assert.match(html, /openrouter/);
  assert.match(html, /repo · 202610/);
  assert.match(html, /title="20261020-abcdef"/);
  assert.doesNotMatch(html, /hermes:/);

  const mission = renderToStaticMarkup(createElement(SessionPanel, {
    sessions: [session], activeLabel: formatSessionName(session), version: "v1.2.2",
    todoSummary: "1/2", selectedSessionId: session.id, selectedSession: session,
    onSelectSession: () => {},
  }));
  assert.match(mission, /20261020-abcdef/);
  assert.doesNotMatch(mission, />hermes</);
});

test("assigned names are consistent across agent and session panels without hiding profiles", () => {
  const namedSession = { ...session, displayName: "Tom" };
  const html = renderToStaticMarkup(createElement(AgentPanel, {
    selectedAgent: {
      id: `${session.id}:agent`, source: "hermes", alias: "Tom",
      name: "dev-team", profile: "dev-team", sessionId: session.id,
    },
    sessions: [namedSession],
  }));
  assert.match(html, /Tom · repo/);
  assert.match(html, /Profile<\/span><span class="stat-value">dev-team<\/span>/);
  assert.match(html, /title="20261020-abcdef"/);

  const mission = renderToStaticMarkup(createElement(SessionPanel, {
    sessions: [namedSession], activeLabel: formatSessionName(namedSession), version: "v1.2.2",
    todoSummary: "0/0", selectedSessionId: session.id, selectedSession: namedSession,
    onSelectSession: () => {},
  }));
  assert.match(mission, /Tom · repo/);
  assert.match(mission, /title="20261020-abcdef"/);
  assert.match(mission, /20261020-abcdef/);
});

test("agent session and transmission use opaque light-theme colors", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, {
    selectedAgent: {
      id: `${session.id}:agent`, sessionId: session.id,
      lastMessageSnippet: "Build completed",
    },
    sessions: [session],
  }));
  assert.match(html, /\btext-emerald-900 bg-emerald-50\b/);
  assert.match(html, /\bbg-secondary text-secondary-foreground\b/);
  assert.match(html, /<span class="stat-label mb-1">Last Transmission<\/span>/);
  assert.match(html, /<p class="text-\[9px\] text-secondary-foreground italic">/);
  assert.match(html, /Build completed/);
  assert.doesNotMatch(html, /bg-emerald-950|text-emerald-400\/80|bg-slate-900\/50|text-slate-300/);
});

test("session status badges use contrasting light-theme colors", () => {
  const selectedSession = { ...session, status: "idle" };
  const html = renderToStaticMarkup(createElement(SessionPanel, {
    sessions: [selectedSession], activeLabel: formatSessionName(selectedSession), version: "v1.2.2",
    todoSummary: "0/0", selectedSessionId: selectedSession.id, selectedSession,
    onSelectSession: () => {},
  }));
  assert.match(html, /<span class="[^"]*\bbg-secondary text-secondary-foreground\b[^"]*">idle<\/span>/);
});

test("quest log preserves finished tasks and distinguishes cancelled tasks", () => {
  const html = renderToStaticMarkup(createElement(TodoPanel, {
    todos: [
      { id: "1", content: "Investigate", status: "completed" },
      { id: "2", content: "Fix mapping", status: "in_progress" },
      { id: "3", content: "Discard", status: "cancelled" },
    ],
  }));
  assert.match(html, /Investigate/);
  assert.match(html, /IN PROGRESS/);
  assert.match(html, /CANCELLED/);
});
