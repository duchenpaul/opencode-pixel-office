import type { SessionInfo } from "../useOfficeState";

export const getSessionDisplayId = (id: string) => {
  if (!id.startsWith("hermes:")) return id;
  const value = id.slice("hermes:".length);
  return decodeURIComponent(value.slice(value.indexOf(":") + 1));
};

export const getHermesResumeCommand = (sessionId: string, profile: string) => {
  const quote = (value: string) => /^[a-zA-Z0-9_./:-]+$/.test(value)
    ? value : `'${value.replace(/'/g, "'\\''")}'`;
  return `hermes --profile ${quote(profile)} --resume ${quote(getSessionDisplayId(sessionId))}`;
};

export const getSessionContext = (session: SessionInfo) =>
  session.directory?.split("/").filter(Boolean).pop()
  || session.title
  || session.slug
  || session.profile
  || "";

export const formatSessionName = (session: SessionInfo) => {
  const context = getSessionContext(session);
  if (session.displayName) {
    return context ? `${session.displayName} · ${context}` : session.displayName;
  }
  const shortId = getSessionDisplayId(session.id).slice(0, 6);
  return context ? `${context} · ${shortId}` : shortId;
};
