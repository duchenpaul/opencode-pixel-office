import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { getToolActivity } from "./activity.js";
import type { ActivityKind } from "./activity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT || "5100", 10);
const CLIENT_DIST_DIR = path.join(__dirname, "..", "client", "dist");
const CLIENT_DIR = fs.existsSync(CLIENT_DIST_DIR)
  ? CLIENT_DIST_DIR
  : path.join(__dirname, "..", "client");

if (!fs.existsSync(path.join(CLIENT_DIR, "index.html"))) {
  console.error("[PixelOffice] client bundle missing — run `npm run build:client`");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const validHermesProfile = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const configPath = path.join(os.homedir(), ".opencode", "pixel-office", "config.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const hermesDefaultProfile: string = config.hermesProfile ?? "default";
if (!validHermesProfile(hermesDefaultProfile)) {
  throw new Error(`Invalid Hermes profile in ${configPath}`);
}
const hermesProfiles = new Set<string>([hermesDefaultProfile]);
let hermesActiveProfile: string | null = null;

type BossMessage = {
  text: string;
  status?: string;
  updatedAt: number;
};

type ActiveTool = { name: string; activity: ActivityKind | null };
type PendingApproval = { tool: string; callId: string; requestedAt: number };
const activeTools = new Map<string, Map<string, ActiveTool>>();
const pendingApprovals = new Map<string, Map<string, PendingApproval>>();

type TodoSummary = {
  total: number;
  completed: number;
  updatedAt: number;
};

type TodoItem = {
  id: string;
  content: string;
  status: string;
  priority: string;
};

type SessionInfo = {
  id: string;
  parentSessionId?: string;
  displayName?: string;
  source?: "opencode" | "claude" | "hermes";
  profile?: string;
  title?: string;
  slug?: string;
  status?: string;
  version?: string;
  directory?: string;
  projectId?: string;
  todos?: TodoItem[];
  lastTodoSummary?: TodoSummary;
  updatedAt: number;
};

type OfficeState = {
  agents: Map<string, any>;
  interactions: Map<string, { with: string; updatedAt: number }>;
  aliases: Map<string, string>;
  nextDeskIndex: number;
  activeSessionId: string | null;
  lastActiveAt: number;
  loggedEventTypes: Set<string>;
  appVersion: string | null;
  lastTodoSummary: TodoSummary | null;
  todos: TodoItem[];
  sessions: Map<string, SessionInfo>;
  bossMessage: BossMessage | null;
  messageRoles: Map<string, string>;
  networkIp: string | null;
};

type EventPayload = {
  type?: string;
  source?: "opencode" | "claude" | "hermes";
  properties?: Record<string, any>;
};

const officeState: OfficeState = {
  agents: new Map(),
  interactions: new Map(),
  aliases: new Map(),
  nextDeskIndex: 0,
  activeSessionId: null,
  lastActiveAt: 0,
  loggedEventTypes: new Set(),
  appVersion: null,
  lastTodoSummary: null,
  todos: [],
  sessions: new Map(),
  bossMessage: null,
  messageRoles: new Map(),
  networkIp: null,
};

const MAX_DESKS = 15;
const DESK_COLUMNS = 5;
const IDLE_TTL_MS = 6000;
const SESSION_NAMES = [
  "Tom", "Jerry", "Jack", "Oliver", "Henry", "Leo", "Max", "Sam",
  "Ben", "Emma", "Lucy", "Lily", "Alice", "Grace", "Ruby",
];

const KNOWN_EVENTS = new Set([
  "command.executed",
  "file.edited",
  "file.watcher.updated",
  "installation.updated",
  "lsp.client.diagnostics",
  "lsp.updated",
  "message.part.removed",
  "message.part.updated",
  "message.removed",
  "message.updated",
  "permission.asked",
  "permission.replied",
  "server.connected",
  "session.created",
  "session.compacted",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.idle",
  "session.status",
  "session.updated",
  "todo.updated",
  "tool.execute.after",
  "tool.execute.before",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
]);

const safeString = (value: unknown, fallback: string) => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
};

const getEventType = (event: EventPayload) => safeString(event?.type, "").toLowerCase();

const logEventSummary = (event: EventPayload) => {
  const type = getEventType(event);
  const props = event?.properties || {};

  switch (type) {
    case "command.executed": {
      const command = safeString(props.command ?? "", "");
      console.log(`[PixelOffice] command.executed: ${command || "(no command)"}`);
      return;
    }
    case "file.edited":
    case "file.watcher.updated": {
      const file = safeString(props.file ?? "", "");
      console.log(`[PixelOffice] ${type}: ${file || "(no file)"}`);
      return;
    }
    case "installation.updated": {
      const version = safeString(props.version ?? "", "");
      console.log(`[PixelOffice] installation.updated: ${version || "(no version)"}`);
      return;
    }
    case "lsp.client.diagnostics": {
      const diagnostics = Array.isArray(props.diagnostics) ? props.diagnostics : [];
      console.log(`[PixelOffice] lsp.client.diagnostics: ${diagnostics.length} issues`);
      return;
    }
    case "lsp.updated": {
      const status = safeString(props.status ?? "", "");
      console.log(`[PixelOffice] lsp.updated: ${status || "(no status)"}`);
      return;
    }
    case "message.part.removed": {
      const partId = safeString(props.part?.id ?? "", "");
      console.log(`[PixelOffice] message.part.removed: ${partId || "(no part id)"}`);
      return;
    }
    case "message.part.updated": {
      const text = safeString(props.part?.text ?? "", "");
      console.log(`[PixelOffice] message.part.updated: ${text || "(no text)"}`);
      return;
    }
    case "message.removed": {
      const messageId = safeString(props.message?.id ?? "", "");
      console.log(`[PixelOffice] message.removed: ${messageId || "(no message id)"}`);
      return;
    }
    case "message.updated": {
      const text = normalizeMessageContent(props.message?.content);
      console.log(`[PixelOffice] message.updated: ${text || "(no content)"}`);
      return;
    }
    case "permission.asked":
    case "permission.replied": {
      const permission = safeString(props.permission?.action ?? "", "");
      console.log(`[PixelOffice] ${type}: ${permission || "(no permission)"}`);
      return;
    }
    case "server.connected": {
      const host = safeString(props.server?.host ?? "", "");
      console.log(`[PixelOffice] server.connected: ${host || "(no host)"}`);
      return;
    }
    case "session.created":
    case "session.compacted":
    case "session.deleted":
    case "session.diff":
    case "session.error":
    case "session.idle":
    case "session.status":
    case "session.updated": {
      if (type === "session.diff") {
        const diff = Array.isArray(props.diff) ? props.diff : [];
        if (diff.length === 0) {
          return;
        }
      }
      const sessionId = safeString(props.info?.id ?? props.sessionID ?? "", "");
      const status = safeString(props.status?.type ?? "", "");
      const suffix = status ? ` (${status})` : "";
      console.log(`[PixelOffice] ${type}: ${sessionId || "(no session)"}${suffix}`);
      return;
    }
    case "todo.updated": {
      const todos = Array.isArray(props.todos) ? props.todos : [];
      const completed = todos.filter((todo) => todo.status === "completed").length;
      console.log(`[PixelOffice] todo.updated: ${completed}/${todos.length}`);
      return;
    }
    case "tool.execute.after":
    case "tool.execute.before": {
      const toolName = safeString(props.tool?.name ?? "", "");
      console.log(`[PixelOffice] ${type}: ${toolName || "(no tool)"}`);
      return;
    }
    case "tui.prompt.append": {
      const prompt = safeString(props.prompt ?? "", "");
      console.log(`[PixelOffice] tui.prompt.append: ${prompt || "(no prompt)"}`);
      return;
    }
    case "tui.command.execute": {
      const command = safeString(props.command ?? "", "");
      console.log(`[PixelOffice] tui.command.execute: ${command || "(no command)"}`);
      return;
    }
    case "tui.toast.show": {
      const message = safeString(props.message ?? "", "");
      console.log(`[PixelOffice] tui.toast.show: ${message || "(no message)"}`);
      return;
    }
    default:
      console.log(`[PixelOffice] ${type}`);
  }
};

const normalizeMessageContent = (content: unknown) => {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item.text === "string") {
          return item.text.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
};

const extractUserMessage = (event: EventPayload) => {
  const props = event?.properties || {};
  const message = props.message || {};
  const part = props.part || {};
  const info = props.info || {};
  const eventType = getEventType(event);
  if (eventType !== "message.updated" && eventType !== "message.part.updated") {
    return null;
  }
  const role = safeString(info.role ?? message.role ?? "", "").toLowerCase();
  const roleIsUser = role === "user";
  const roleIsAssistant = role === "assistant" || role === "system";
  const messageId = safeString(
    eventType === "message.part.updated" ? part.messageID ?? "" : info.id ?? "",
    ""
  );
  if (messageId && role) {
    officeState.messageRoles.set(messageId, role);
  }
  const storedRole = messageId ? officeState.messageRoles.get(messageId) : "";
  const isUser = roleIsUser || storedRole === "user";
  if (!isUser || roleIsAssistant) {
    return null;
  }
  const text =
    eventType === "message.part.updated"
      ? safeString(part.text ?? "", "")
      : normalizeMessageContent(message.content) || safeString(message.text ?? "", "");
  if (!text) {
    return null;
  }
  const status = safeString(message.status ?? "", "");
  return { text, status };
};

const extractAgentId = (event: EventPayload) => {
  const props = event?.properties || {};
  const info = props.info || {};
  const agentName = safeString(info.agent ?? "", "");
  const sessionId = safeString(info.sessionID ?? props.sessionID ?? props.part?.sessionID, "");
  if (agentName && sessionId) {
    return `${sessionId}:${agentName}`;
  }
  if (agentName) {
    return agentName;
  }
  return sessionId;
};

const extractSessionId = (event: EventPayload) => {
  const props = event?.properties || {};
  const info = props.info || {};
  const part = props.part || {};
  const eventType = getEventType(event);
  if (eventType === "session.updated" || eventType === "session.created" || eventType === "session.compacted") {
    return safeString(info.id ?? "", "");
  }
  if (
    eventType === "session.status" ||
    eventType === "session.diff" ||
    eventType === "session.idle" ||
    eventType === "session.deleted" ||
    eventType === "session.error" ||
    eventType === "todo.updated"
  ) {
    return safeString(props.sessionID ?? info.sessionID, "");
  }
  if (eventType === "message.part.updated") {
    return safeString(part.sessionID ?? "", "");
  }
  if (eventType === "file.edited" || eventType === "file.watcher.updated") {
    return safeString(props.sessionID ?? "", "");
  }
  return safeString(props.sessionID ?? info.sessionID ?? part.sessionID, "");
};

const isSessionOnlyOrPartEvent = (event: EventPayload) => {
  const type = getEventType(event);
  return (
    type === "session.updated" ||
    type === "session.status" ||
    type === "session.diff" ||
    type === "session.idle" ||
    type === "session.deleted" ||
    type === "session.error" ||
    type === "session.created" ||
    type === "session.compacted" ||
    type === "tui.toast.show" ||
    type === "message.part.updated"
  );
};

const resolveAgentIdsForEvent = (event: EventPayload) => {
  const props = event?.properties || {};
  const info = props.info || {};
  const sessionId = extractSessionId(event);
  if (event.source === "hermes") {
    return sessionId ? [`${sessionId}:agent`] : [];
  }
  const agentName = safeString(info.agent ?? "", "");
  if (!sessionId) {
    const direct = extractAgentId(event);
    return direct ? [direct] : [];
  }

  const matches = Array.from(officeState.agents.values())
    .filter((agent) => agent.sessionId === sessionId)
    .map((agent) => agent.id);
  if (matches.length > 0) {
    return matches;
  }

  if (isSessionOnlyOrPartEvent(event)) {
    return getEventType(event) === "session.created" && agentName
      ? [`${sessionId}:${agentName}`] : [];
  }

  if (agentName) {
    return [`${sessionId}:${agentName}`];
  }

  const direct = extractAgentId(event);
  return direct ? [direct] : [];
};

const isSessionOnlyEvent = (event: EventPayload) => {
  const type = getEventType(event);
  return (
    type === "session.updated" ||
    type === "session.status" ||
    type === "session.diff" ||
    type === "session.idle" ||
    type === "session.deleted" ||
    type === "session.error"
  );
};

const extractAgentName = (event: EventPayload, agentId: string) => {
  const props = event?.properties || {};
  const info = props.info || {};
  const session = props.session || {};
  const preferred = safeString(info.agent ?? session.name ?? agentId, agentId);
  if (preferred === agentId) {
    return agentId;
  }
  if (preferred.startsWith("ses_")) {
    return agentId;
  }
  if (preferred.includes("session")) {
    return agentId;
  }
  return preferred;
};

const extractAgentModel = (event: EventPayload) => {
  const props = event?.properties || {};
  const info = props.info || {};
  return safeString(info.model?.modelID ?? "unknown", "unknown");
};

const extractActiveSessionId = (event: EventPayload) => {
  const props = event?.properties || {};
  const info = props.info || {};
  const eventType = getEventType(event);
  if (
    eventType === "session.status" ||
    eventType === "session.diff" ||
    eventType === "session.idle" ||
    eventType === "session.deleted" ||
    eventType === "session.error" ||
    eventType === "todo.updated"
  ) {
    return safeString(props.sessionID ?? info.sessionID, "");
  }
  if (eventType === "session.updated" || eventType === "session.created" || eventType === "session.compacted") {
    return safeString(info.id ?? "", "");
  }
  return safeString(props.sessionID ?? info.sessionID ?? props.part?.sessionID, "");
};

const applySessionLifecycle = (event: EventPayload) => {
  const type = getEventType(event);
  if (type === "session.deleted") {
    const removedSessions = new Set([extractSessionId(event)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of officeState.agents.values()) {
        if (removedSessions.has(agent.parentSessionId) && !removedSessions.has(agent.sessionId)) {
          removedSessions.add(agent.sessionId);
          changed = true;
        }
      }
    }
    const removedAgents = new Set<string>();
    for (const [id, agent] of officeState.agents) {
      if ((agent.source || "opencode") === (event.source || "opencode") && removedSessions.has(agent.sessionId)) {
        removedAgents.add(id);
        officeState.agents.delete(id);
        activeTools.delete(id);
        pendingApprovals.delete(id);
        officeState.aliases.delete(id);
      }
    }
    for (const id of removedSessions) officeState.sessions.delete(id);
    for (const [from, interaction] of officeState.interactions) {
      if (removedAgents.has(from) || removedAgents.has(interaction.with)) {
        officeState.interactions.delete(from);
      }
    }
    if (officeState.activeSessionId && removedSessions.has(officeState.activeSessionId)) {
      officeState.activeSessionId = null;
    }
    return;
  }
  if (type === "session.idle") {
    const agentIds = resolveAgentIdsForEvent(event);
    agentIds.forEach((agentId) => {
      if (officeState.agents.has(agentId)) {
        const existing = officeState.agents.get(agentId);
        officeState.agents.set(agentId, {
          ...existing,
          status: "idle",
          updatedAt: Date.now(),
        });
      }
    });
  }
};

const getAlias = (agentId: string, sessionId: string) => {
  const session = officeState.sessions.get(sessionId);
  let alias = session?.displayName || officeState.aliases.get(agentId);
  if (!alias) {
    const usedNames = new Set(officeState.aliases.values());
    for (const activeSession of officeState.sessions.values()) {
      if (activeSession.displayName) usedNames.add(activeSession.displayName);
    }
    let suffix = 1;
    let availableNames: string[];
    do {
      availableNames = SESSION_NAMES
        .map((name) => suffix === 1 ? name : `${name} ${suffix}`)
        .filter((name) => !usedNames.has(name));
      suffix += 1;
    } while (availableNames.length === 0);
    alias = availableNames[Math.floor(Math.random() * availableNames.length)];
  }
  officeState.aliases.set(agentId, alias);
  if (session && session.displayName !== alias) {
    officeState.sessions.set(sessionId, { ...session, displayName: alias });
  }
  return alias;
};

const mapStatusFromEvent = (event: EventPayload) => {
  const type = getEventType(event);
  if (type === "permission.asked") return "waiting";
  if (type === "permission.replied") return "thinking";
  const props = event.properties || {};
  const toolPartStatus = props.part?.type === "tool" ? props.part.state?.status : "";
  if (toolPartStatus === "pending" || toolPartStatus === "running") return "working";
  if (toolPartStatus === "completed") return "thinking";
  if (toolPartStatus === "error") return "error";
  const status = safeString(props.status?.type ?? props.status, "").toLowerCase();

  if (status) {
    return status === "busy" ? "working" : status === "success" ? "thinking" : status;
  }
  if (type === "session.error") {
    return "error";
  }
  if (type === "tool.execute.before") {
    return "working";
  }
  if (type === "tool.execute.after") {
    return "thinking";
  }
  if (type.startsWith("message.")) {
    return "thinking";
  }
  if (type === "session.idle") {
    return "idle";
  }
  if (type === "session.created") {
    return "idle";
  }
  if (type === "session.status") {
    return "working";
  }
  if (type === "session.compacted") {
    return "planning";
  }
  return "working";
};

const extractParentId = (event: EventPayload) => {
  const props = event?.properties || {};
  return safeString(props.parentSessionId ?? props.info?.parentID ?? props.info?.parentSessionId, "");
};

const extractSessionInfo = (event: EventPayload) => {
  const props = event?.properties || {};
  const info = props.info || {};
  const eventType = getEventType(event);
  if (
    event.source !== "hermes" &&
    eventType !== "session.updated" &&
    eventType !== "session.created" &&
    eventType !== "session.compacted"
  ) {
    return null;
  }
  const sessionId = safeString(info.id ?? "", "");
  if (!sessionId) {
    return null;
  }
  return {
    id: sessionId,
    parentSessionId: extractParentId(event),
    source: event.source || "opencode",
    profile: safeString(info.profile, ""),
    title: safeString(info.title ?? "", ""),
    slug: safeString(info.slug ?? "", ""),
    status: "",
    version: safeString(info.version ?? "", ""),
    directory: safeString(info.directory ?? "", ""),
    projectId: safeString(info.projectID ?? "", ""),
    updatedAt: Date.now(),
  };
};

const upsertSession = (event: EventPayload) => {
  const info = extractSessionInfo(event);
  if (!info) {
    return;
  }
  const existing = officeState.sessions.get(info.id);
  const nextInfo = existing
    ? {
      ...existing,
      ...info,
      parentSessionId: info.parentSessionId || existing.parentSessionId,
      ...(event.source === "hermes" ? {
        profile: info.profile || existing.profile,
        title: info.title || existing.title,
        slug: info.slug || existing.slug,
        version: info.version || existing.version,
        directory: info.directory || existing.directory,
        projectId: info.projectId || existing.projectId,
        status: getEventType(event) === "todo.updated"
          ? existing.status : mapStatusFromEvent(event),
      } : {}),
      updatedAt: Date.now(),
    }
    : { ...info, ...(event.source === "hermes" ? { status: mapStatusFromEvent(event) } : {}) };
  officeState.sessions.set(info.id, nextInfo);
};

const updateSessionStatus = (event: EventPayload) => {
  const eventType = getEventType(event);
  if (eventType !== "session.status") {
    return;
  }
  const props = event?.properties || {};
  const info = props.info || {};
  const sessionId = safeString(props.sessionID ?? "", "");
  if (!sessionId) {
    return;
  }
  const status = safeString(props.status?.type ?? "", "");
  const existing = officeState.sessions.get(sessionId);
  const nextInfo = existing
    ? {
      ...existing,
      status,
      updatedAt: Date.now(),
    }
    : {
      id: sessionId,
      source: event.source || "opencode",
      title: safeString(info.title ?? "", ""),
      slug: safeString(info.slug ?? "", ""),
      status,
      version: safeString(info.version ?? "", ""),
      directory: safeString(info.directory ?? "", ""),
      projectId: safeString(info.projectID ?? "", ""),
      updatedAt: Date.now(),
    };
  officeState.sessions.set(sessionId, nextInfo);
};

const assignDesk = () => {
  const deskIndex = officeState.nextDeskIndex % MAX_DESKS;
  officeState.nextDeskIndex += 1;
  return {
    deskIndex,
    row: Math.floor(deskIndex / DESK_COLUMNS),
    column: deskIndex % DESK_COLUMNS,
  };
};

const extractSessionTitle = (event: EventPayload) => {
  const info = event?.properties?.info || {};
  return safeString(info.title ?? "", "");
};

const isBackgroundSession = (title: string) =>
  Boolean(title) &&
  (title.toLowerCase().includes("subagent") ||
    title.toLowerCase().includes("looker") ||
    title.toLowerCase().includes("multimodal"));

const updateAgentActivity = (
  event: EventPayload, agentId: string, now: number,
  previous?: { activity?: ActivityKind | null; activityUntil?: number }
) => {
  const type = getEventType(event);
  const props = event.properties || {};
  const part = props.part || {};
  const isToolPart = type === "message.part.updated" && part.type === "tool";
  const toolName = safeString(isToolPart ? part.tool : props.tool?.name, "");
  const explicitCallId = safeString(part.callID ?? props.tool?.id ?? props.tool?.callID ?? props.callID, "");
  const callId = explicitCallId || toolName;
  const tools = activeTools.get(agentId) || new Map<string, ActiveTool>();
  const approvals = pendingApprovals.get(agentId) || new Map<string, PendingApproval>();
  const starting = type === "tool.execute.before" ||
    (isToolPart && (part.state?.status === "running" || part.state?.status === "pending"));
  const finished = type === "tool.execute.after" ||
    (isToolPart && (part.state?.status === "completed" || part.state?.status === "error"));
  const ended = type === "session.idle" || type === "session.error" ||
    (type === "session.status" && props.status?.type === "idle");
  if (ended) {
    tools.clear();
    approvals.clear();
  }
  if (starting && toolName) {
    tools.delete(callId);
    tools.set(callId, { name: toolName, activity: getToolActivity(toolName) });
  }
  if (finished) {
    if (callId) tools.delete(callId);
    else tools.clear();
    for (const [id, approval] of approvals) {
      const matches = approval.callId && explicitCallId
        ? approval.callId === explicitCallId
        : !toolName || approval.tool === toolName || !approval.tool;
      if (matches) {
        approvals.delete(id);
        if (toolName || explicitCallId) break;
      }
    }
  }
  if (type === "permission.asked") {
    const approvalTool = safeString(props.permission?.tool, "") ||
      safeString(props.permission?.action, "") || safeString(props.permission, "") ||
      safeString(props.tool?.name, "");
    const requestId = safeString(props.id ?? props.permission?.id, "");
    const id = requestId || approvalTool || "approval";
    if (!approvals.has(id) && (approvalTool || requestId || !approvals.size)) {
      approvals.set(id, { tool: approvalTool, callId: explicitCallId, requestedAt: now });
    }
  }
  if (type === "permission.replied") {
    const id = safeString(props.requestID ?? props.id ?? props.permission?.id, "");
    if (id) approvals.delete(id);
    else approvals.clear();
  }
  if (tools.size) activeTools.set(agentId, tools);
  else activeTools.delete(agentId);
  if (approvals.size) pendingApprovals.set(agentId, approvals);
  else pendingApprovals.delete(agentId);
  const currentTool = Array.from(tools.values()).at(-1);
  const approvalEntry = Array.from(approvals.entries()).at(-1);
  const approval = approvalEntry?.[1];
  const fileEdited = type === "file.edited" || type === "file.watcher.updated";
  const transientActivity = fileEdited ? "writing"
    : type === "command.executed" ? "terminal"
    : finished ? getToolActivity(toolName) : null;
  return {
    activity: ended ? null : currentTool ? currentTool.activity : transientActivity ||
      ((previous?.activityUntil || 0) > now ? previous?.activity : null),
    activityUntil: currentTool || ended ? 0 : transientActivity ? now + 1400 : previous?.activityUntil || 0,
    toolName: currentTool?.name || "",
    approvalTool: approval?.tool || "",
    approvalRequestId: approvalEntry?.[0] || "",
    approvalRequestedAt: approval?.requestedAt || 0,
  };
};

const pruneAgents = () => {
  const now = Date.now();
  for (const [key, agent] of officeState.agents.entries()) {
    if (agent.source === "hermes" || pendingApprovals.has(key) || activeTools.has(key)) {
      continue;
    }
    const lastActivity = agent.lastActivityAt || agent.lastMessageAt || 0;
    if (!agent.isBackground && agent.status !== "idle" && lastActivity) {
      if (now - lastActivity > IDLE_TTL_MS) {
        officeState.agents.set(key, {
          ...agent,
          status: "idle",
          updatedAt: now,
        });
      }
    }
    if (
      agent.isBackground &&
      agent.status !== "idle" &&
      agent.status !== "error" &&
      agent.lastActivityAt &&
      now - agent.lastActivityAt > 4000
    ) {
      officeState.agents.set(key, {
        ...agent,
        status: "idle",
        updatedAt: now,
      });
    }
    if (
      agent.isBackground &&
      agent.status === "idle" &&
      now - agent.updatedAt > 3000
    ) {
      officeState.agents.delete(key);
      activeTools.delete(key);
      pendingApprovals.delete(key);
      officeState.aliases.delete(key);
      officeState.interactions.delete(key);
    }
  }
};

const setInteraction = (fromId: string, toId: string) => {
  if (!fromId || !toId || fromId === toId) {
    return;
  }
  officeState.interactions.set(fromId, {
    with: toId,
    updatedAt: Date.now(),
  });
};

const pruneInteractions = () => {
  const now = Date.now();
  for (const [key, value] of officeState.interactions.entries()) {
    if (now - value.updatedAt > 15_000) {
      officeState.interactions.delete(key);
    }
  }
};

const upsertAgentFromEvent = (event: EventPayload) => {
  const agentIds = resolveAgentIdsForEvent(event);
  const targetIds = isSessionOnlyOrPartEvent(event)
    ? agentIds
    : agentIds.length > 0
      ? agentIds
      : [extractAgentId(event)];
  const cleanedIds = targetIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
  if (cleanedIds.length === 0) {
    return null;
  }
  if (isSessionOnlyOrPartEvent(event) && event.source !== "hermes" && getEventType(event) !== "session.created") {
    const hasAgentMatch = cleanedIds.some((id) => officeState.agents.has(id));
    if (!hasAgentMatch) {
      return null;
    }
  }
  const props = event?.properties || {};
  const part = props.part || {};
  const partText = safeString(part.text, "");
  const partContent = safeString(part.content, "");
  const partDelta = safeString(part.delta, "");
  const messageSnippet = partText || partContent || partDelta;
  const status = mapStatusFromEvent(event);
  const model = extractAgentModel(event);
  const provider = safeString(event?.properties?.info?.model?.providerID, "");
  const modelId = safeString(event?.properties?.info?.model?.modelID, "");
  const rawSessionId = extractSessionId(event);
  const sessionTitle = extractSessionTitle(event);
  const updatedAt = Date.now();
  const eventType = getEventType(event);
  const eventSource = event?.source || "opencode";
  const isPartUpdate = eventType === "message.part.updated";
  const messageId = isPartUpdate
    ? safeString(part.messageID ?? "", "")
    : safeString(props.info?.id ?? "", "");
  const messageRole = messageId ? officeState.messageRoles.get(messageId) : "";
  const isUserMessage = messageRole === "user";
  let primaryId = cleanedIds[0];

  cleanedIds.forEach((agentId) => {
    const existing = officeState.agents.get(agentId);
    const name = event.source === "hermes"
      ? safeString(props.info?.agent, existing?.name || "Hermes")
      : isSessionOnlyOrPartEvent(event)
      ? existing?.name || extractAgentName(event, agentId)
      : extractAgentName(event, agentId);
    const nextSessionId = rawSessionId || existing?.sessionId || "";
    const parentSessionId = extractParentId(event) ||
      officeState.sessions.get(nextSessionId)?.parentSessionId || existing?.parentSessionId || "";
    const alias = getAlias(agentId, nextSessionId);
    const resolvedModel = modelId || model;
    const nextModel =
      resolvedModel !== "unknown"
        ? resolvedModel
        : existing?.model || "unknown";
    const nextProvider = provider || existing?.provider || "";
    const nextSessionTitle = sessionTitle || existing?.sessionTitle || "";
    const nextIsBackground = event.source === "hermes" ? false : isBackgroundSession(nextSessionTitle);

    const nextMessageSnippet = event.source === "hermes"
      ? safeString(props.preview, "") || existing?.lastMessageSnippet || ""
      : isUserMessage
      ? existing?.lastMessageSnippet || ""
      : isPartUpdate && !partText && !partContent && partDelta
        ? `${existing?.lastMessageSnippet || ""}${partDelta}`
        : messageSnippet || existing?.lastMessageSnippet || "";
    const trimmedSnippet =
      nextMessageSnippet.length > 400
        ? nextMessageSnippet.slice(-400)
        : nextMessageSnippet;
    const hasMessageUpdate = !isUserMessage && Boolean(
      eventSource === "hermes" ? safeString(props.preview, "") : messageSnippet
    );
    const now = Date.now();
    const activityState = updateAgentActivity(event, agentId, now, existing);
    const isFileEditEvent = eventType === "file.edited" || eventType === "file.watcher.updated";
    const isActivityEvent =
      (eventSource === "hermes" && (
        eventType === "session.created" ||
        eventType === "tool.execute.after" ||
        eventType === "permission.asked" ||
        eventType === "permission.replied"
      )) ||
      eventType === "tool.execute.before" ||
      eventType === "tool.execute.after" ||
      eventType === "permission.asked" ||
      eventType === "permission.replied" ||
      eventType === "command.executed" ||
      isFileEditEvent ||
      isPartUpdate ||
      (eventType === "message.updated" && hasMessageUpdate);
    const nextMessageAt = hasMessageUpdate
      ? now
      : existing?.lastMessageAt || 0;
    const nextStreamingAt = isPartUpdate && hasMessageUpdate
      ? now
      : existing?.lastStreamingAt || 0;
    const nextActivityAt = isActivityEvent
      ? now
      : existing?.lastActivityAt || 0;
    let nextStatus = status;
    if (activityState.approvalRequestedAt) {
      nextStatus = "waiting";
    } else if (eventType !== "permission.replied" && status !== "error") {
      if (activeTools.has(agentId)) nextStatus = "working";
      else if (event.source !== "hermes" && existing?.status === "idle" && !isActivityEvent) nextStatus = "idle";
    }

    if (existing) {
      officeState.agents.set(agentId, {
        ...existing,
        name,
        alias,
        model: nextModel,
        provider: nextProvider,
        sessionId: nextSessionId,
        sessionTitle: nextSessionTitle,
        isBackground: nextIsBackground,
        status: nextStatus,
        ...activityState,
        parentSessionId,
        role: safeString(props.info?.role, existing.role || ""),
        source: existing.source || eventSource,
        ...(eventSource === "hermes" ? {
          profile: safeString(props.info?.profile, existing.profile || ""),
        } : {}),
        lastEventType: event?.type || existing.lastEventType,
        lastMessageSnippet: trimmedSnippet,
        lastMessageAt: nextMessageAt,
        lastStreamingAt: nextStreamingAt,
        lastActivityAt: nextActivityAt,
        lastStatusType: props.status?.type || existing.lastStatusType || "",
        lastEventAt: now,
        lastDiffAt: eventType === "session.diff" ? Date.now() : existing.lastDiffAt,
        lastFileEdited: props.file || existing.lastFileEdited || "",
        lastFileEditAt: isFileEditEvent ? Date.now() : existing.lastFileEditAt,
        updatedAt,
      });
    } else {
      officeState.agents.set(agentId, {
        id: agentId,
        name,
        alias,
        model: nextModel,
        provider: nextProvider,
        sessionId: nextSessionId,
        sessionTitle: nextSessionTitle,
        isBackground: nextIsBackground,
        status: nextStatus,
        ...activityState,
        parentSessionId,
        role: safeString(props.info?.role, ""),
        source: eventSource,
        ...(eventSource === "hermes" ? {
          profile: safeString(props.info?.profile, ""),
        } : {}),
        lastEventType: event?.type || "unknown",
        lastMessageSnippet: trimmedSnippet,
        lastMessageAt: hasMessageUpdate ? Date.now() : 0,
        lastStreamingAt: isPartUpdate && hasMessageUpdate ? Date.now() : 0,
        lastActivityAt: isActivityEvent ? Date.now() : 0,
        lastStatusType: props.status?.type || "",
        lastEventAt: now,
        lastDiffAt: eventType === "session.diff" ? Date.now() : 0,
        lastFileEdited: props.file || "",
        lastFileEditAt: isFileEditEvent ? Date.now() : 0,
        updatedAt,
        desk: assignDesk(),
      });
    }
    const session = officeState.sessions.get(nextSessionId);
    if (session) officeState.sessions.set(nextSessionId, { ...session, status: nextStatus });
  });

  return primaryId;
};

const updateBossMessage = (event: EventPayload) => {
  const userMessage = extractUserMessage(event);
  if (!userMessage) {
    return;
  }
  officeState.bossMessage = {
    ...userMessage,
    updatedAt: Date.now(),
  };
};

const getStateSnapshot = () => {
  pruneInteractions();
  pruneAgents();
  return {
    agents: Array.from(officeState.agents.values()),
    sessions: Array.from(officeState.sessions.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    ),
    todos: officeState.todos,
    activeSessionId: officeState.activeSessionId,
    appVersion: officeState.appVersion,
    lastTodoSummary: officeState.lastTodoSummary,
    interactions: Array.from(officeState.interactions.entries()).map(
      ([from, info]) => ({
        from,
        to: info.with,
        updatedAt: info.updatedAt,
      })
    ),
    bossMessage: officeState.bossMessage,
    networkIp: officeState.networkIp,
    hermesProfiles: Array.from(hermesProfiles).sort(),
    hermesDefaultProfile,
    hermesActiveProfile,
    updatedAt: Date.now(),
  };
};

const broadcast = (payload: unknown) => {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
};

app.post("/events", (req: any, res: any) => {
  let event = req.body as EventPayload;
  if (event?.source === "hermes") {
    const props = event.properties || {};
    if (getEventType(event) === "hermes.profiles") {
      if (!Array.isArray(props.profiles) || props.profiles.length > 256 ||
          !props.profiles.every(validHermesProfile)) {
        res.status(400).json({ error: "Hermes profile discovery requires a list of valid profile names" });
        return;
      }
      for (const profile of props.profiles) hermesProfiles.add(profile);
      broadcast({ type: "state", state: getStateSnapshot() });
      res.status(202).json({ ok: true });
      return;
    }
    if (getEventType(event) === "hermes.profile") {
      if (!validHermesProfile(props.profile)) {
        res.status(400).json({ error: "Hermes runtime profile requires a valid profile name" });
        return;
      }
      hermesActiveProfile = props.profile;
      hermesProfiles.add(props.profile);
      broadcast({ type: "state", state: getStateSnapshot() });
      res.status(202).json({ ok: true });
      return;
    }
    const info = props.info || {};
    const rawId = safeString(props.sessionID ?? info.sessionID ?? info.id, "");
    if (!rawId) {
      res.status(400).json({ error: "Hermes events require a session identifier" });
      return;
    }
    let profile = safeString(info.profile, "");
    if (profile && !validHermesProfile(profile)) {
      res.status(400).json({ error: "Invalid Hermes profile name" });
      return;
    }
    if (!profile) {
      const encodedId = encodeURIComponent(rawId);
      const matches = Array.from(officeState.sessions.values()).filter((session) =>
        session.source === "hermes" && (session.id === `hermes:${encodedId}` ||
          session.id.endsWith(`:${encodedId}`)));
      if (matches.length > 1) {
        res.status(400).json({ error: "Ambiguous Hermes session identifier; include info.profile" });
        return;
      }
      profile = matches[0]?.profile || "";
    }
    if (profile) hermesProfiles.add(profile);
    const namespace = (id: string) => profile
      ? `hermes:${encodeURIComponent(profile)}:${encodeURIComponent(id)}`
      : `hermes:${encodeURIComponent(id)}`;
    const sessionId = namespace(rawId);
    const parent = safeString(props.parentSessionId ?? info.parentSessionId, "");
    event = {
      ...event,
      properties: {
        ...props,
        sessionID: sessionId,
        info: { ...info, id: sessionId, sessionID: sessionId, profile },
        ...(parent ? { parentSessionId: namespace(parent) } : {}),
      },
    };
  }
  const eventType = getEventType(event) || "unknown";
  // console.log(`[PixelOffice] Event received: ${eventType}`);
  if (!officeState.loggedEventTypes.has(eventType)) {
    officeState.loggedEventTypes.add(eventType);
  }
  if (!KNOWN_EVENTS.has(eventType)) {
    res.status(202).json({ ok: true });
    return;
  }
  if (event.source === "hermes") {
    hermesActiveProfile = safeString(event.properties?.info?.profile, "") || null;
  }
  logEventSummary(event);

  if (eventType === "installation.updated") {
    const nextVersion = safeString(event?.properties?.version ?? "", "");
    officeState.appVersion = nextVersion || null;
  }

  if (eventType === "session.diff") {
    const diff = Array.isArray(event?.properties?.diff)
      ? event.properties.diff
      : [];
    if (diff.length === 0) {
      res.status(202).json({ ok: true });
      return;
    }
  }

  const activeSessionId = extractActiveSessionId(event);
  if (activeSessionId) {
    officeState.activeSessionId = activeSessionId;
    officeState.lastActiveAt = Date.now();
  }

  upsertSession(event);
  updateSessionStatus(event);

  if (eventType === "todo.updated") {
    const todos = Array.isArray(event?.properties?.todos)
      ? event.properties.todos
      : [];
    const completed = todos.filter((todo) => todo.status === "completed").length;
    const updatedAt = Date.now();
    const clearCompleted = event.source !== "hermes" && todos.length > 0 && completed === todos.length;
    const nextTodos = clearCompleted ? [] : todos.map((todo) => ({
        id: safeString(todo.id, ""),
        content: safeString(todo.content, ""),
        status: safeString(todo.status, ""),
        priority: safeString(todo.priority, ""),
    }));
    const summary = {
      total: clearCompleted ? 0 : todos.length,
      completed: clearCompleted ? 0 : completed,
      updatedAt,
    };
    if (event.source !== "hermes") {
      officeState.todos = nextTodos;
      officeState.lastTodoSummary = summary;
    }
    const sessionId = extractSessionId(event);
    if (sessionId) {
      officeState.sessions.set(sessionId, {
        ...officeState.sessions.get(sessionId),
        id: sessionId,
        source: event.source || "opencode",
        todos: nextTodos,
        lastTodoSummary: summary,
        updatedAt,
      });
    }
  }

  applySessionLifecycle(event);
  const agentId = eventType === "session.deleted" || (event.source === "hermes" && eventType === "todo.updated")
    ? null : upsertAgentFromEvent(event);
  updateBossMessage(event);
  const parentId = extractParentId(event) || (agentId ? officeState.agents.get(agentId)?.parentSessionId : "");
  if (agentId && parentId) {
    const parentAgent = Array.from(officeState.agents.values()).find((agent) => agent.sessionId === parentId);
    if (parentAgent) setInteraction(parentAgent.id, agentId);
  }

  broadcast({ type: "event", event });
  broadcast({ type: "state", state: getStateSnapshot() });
  res.status(202).json({ ok: true });
});

app.get("/health", (_req: any, res: any) => {
  res.json({ ok: true });
});

wss.on("connection", (socket: any) => {
  socket.send(JSON.stringify({ type: "state", state: getStateSnapshot() }));
});

const getLocalIp = () => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
};

server.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : PORT;
  officeState.networkIp = ip;
  console.log(`Pixel Office Server Running:`);
  console.log(`  Local:   http://localhost:${port}`);
  console.log(`  Network: http://${ip}:${port}`);
});
