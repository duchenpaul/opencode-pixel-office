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
