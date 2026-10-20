import type { Agent, SessionInfo } from "../useOfficeState";

export const UNPROFILED_HERMES = "__unprofiled__";

export const matchesHermesProfile = (item: { profile?: string }, profile: string) =>
  profile === "" || (profile === UNPROFILED_HERMES ? !item.profile : item.profile === profile);

export const getHermesProfiles = (
  profiles: string[], defaultProfile: string, agents: Agent[], sessions: SessionInfo[]
) => Array.from(new Set([
  defaultProfile,
  ...profiles,
  ...agents.filter((agent) => agent.source === "hermes").map((agent) => agent.profile || ""),
  ...sessions.filter((session) => session.source === "hermes").map((session) => session.profile || ""),
])).filter(Boolean).sort();
