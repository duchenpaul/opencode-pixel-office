import type { Agent } from "../useOfficeState";

export const isAwaitingApproval = (agent: Agent) => agent.status === "waiting";

export const approvalKey = (agent: Agent) =>
  `${agent.id}:${agent.approvalRequestId || ""}:${agent.approvalRequestedAt || 0}`;

export const getAgentActivity = (agent: Agent, now: number) => {
  if (isAwaitingApproval(agent)) return "approval";
  if (agent.status === "idle" || agent.status === "error") return null;
  return agent.toolName || now < (agent.activityUntil || 0) ? agent.activity || null : null;
};

export const ACTIVITY_LABELS = {
  writing: "Writing files",
  reading: "Reading files",
  research: "Researching the web",
  terminal: "Running terminal commands",
  approval: "Awaiting approval",
};
