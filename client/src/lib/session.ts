import type { SessionInfo } from "../useOfficeState";

export const getSessionDisplayId = (id: string) =>
  id.startsWith("hermes:") ? decodeURIComponent(id.slice("hermes:".length)) : id;

export const getSessionContext = (session: SessionInfo) =>
  session.directory?.split("/").filter(Boolean).pop()
  || session.title
  || session.slug
  || session.profile
  || "";

export const formatSessionName = (session: SessionInfo) => {
  const context = getSessionContext(session);
  const shortId = getSessionDisplayId(session.id).slice(0, 6);
  return context ? `${context} · ${shortId}` : shortId;
};
