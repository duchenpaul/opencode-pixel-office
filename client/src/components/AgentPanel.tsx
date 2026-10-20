import type { Agent, SessionInfo } from "../useOfficeState";
import { getHermesResumeCommand, getSessionContext, getSessionDisplayId } from "../lib/session";
import { ACTIVITY_LABELS, getAgentActivity, isAwaitingApproval } from "../lib/activity";

type AgentPanelProps = {
  selectedAgent: Agent | null;
  sessions: SessionInfo[];
};

const AgentPanel = ({ selectedAgent, sessions }: AgentPanelProps) => {
  const agentSession = selectedAgent?.sessionId
    ? sessions.find((s) => s.id === selectedAgent.sessionId)
    : null;
  const repoName = agentSession ? getSessionContext(agentSession) : "";
  const activity = selectedAgent ? getAgentActivity(selectedAgent, Date.now()) : null;

  return (
    <div className="data-panel">
      <div className="gamish-panel-title">
        <span>AGENT PROFILE</span>
      </div>

      {selectedAgent ? (
        <div className="flex flex-col gap-4">
          <div className="flex gap-3 items-center">
            <div className="w-10 h-10 bg-slate-900 border-2 border-slate-600 rounded flex items-center justify-center">
              <span className="text-xl">👾</span>
            </div>
            <div className="flex flex-col">
              <span className="text-primary font-bold text-xs uppercase tracking-wider">
                {repoName
                  ? `${selectedAgent.alias || selectedAgent.name || "Agent"} · ${repoName}`
                  : selectedAgent.alias || selectedAgent.name || "Unknown Agent"}
              </span>
              <span className="text-[9px] text-slate-400 uppercase">
                {selectedAgent.parentSessionId ? `Helper · ${selectedAgent.role || selectedAgent.name || "Subagent"}` : selectedAgent.role || "Operative"}
              </span>
            </div>
          </div>

          <div className="agent-stats">
            <div className="stat-box">
              <span className="stat-label">Model</span>
              <span className="stat-value truncate block">{selectedAgent.model || "N/A"}</span>
            </div>
            <div className="stat-box">
              <span className="stat-label">Status</span>
              <span className={`stat-value uppercase ${isAwaitingApproval(selectedAgent) ? 'text-red-700' : selectedAgent.status === 'working' ? 'text-amber-400' : 'text-slate-400'}`}>
                {selectedAgent.status || "IDLE"}
              </span>
            </div>
            {activity && (
              <div className="stat-box col-span-2">
                <span className="stat-label">Activity</span>
                <span className="stat-value">{ACTIVITY_LABELS[activity]}</span>
                {(selectedAgent.approvalTool || selectedAgent.toolName) && (
                  <span className="text-[9px] break-all">{selectedAgent.approvalTool || selectedAgent.toolName}</span>
                )}
              </div>
            )}
            <div className="stat-box col-span-2">
              <span className="stat-label">Provider</span>
              <span className="stat-value">{selectedAgent.provider || "Unknown"}</span>
            </div>
            {selectedAgent.profile && (
              <div className="stat-box col-span-2">
                <span className="stat-label">Profile</span>
                <span className="stat-value">{selectedAgent.profile}</span>
              </div>
            )}
          </div>

          {selectedAgent.sessionId && (
            <div className="border-t border-slate-700 pt-2">
              <span className="stat-label mb-1">Assigned Session</span>
              <div
                className="text-[9px] font-mono text-emerald-900 bg-emerald-50 p-1.5 rounded border border-emerald-600 break-all select-all"
                title={getSessionDisplayId(selectedAgent.sessionId)}
              >
                {getSessionDisplayId(selectedAgent.sessionId)}
              </div>
              {selectedAgent.source === "hermes" && selectedAgent.profile && (
                <div className="mt-2">
                  <span className="stat-label mb-1">Resume in Hermes</span>
                  <code className="block text-[9px] text-secondary-foreground break-all select-all">
                    {getHermesResumeCommand(selectedAgent.sessionId, selectedAgent.profile)}
                  </code>
                </div>
              )}
            </div>
          )}

          {selectedAgent.lastMessageSnippet && (
            <div className="bg-secondary text-secondary-foreground p-2 rounded border border-border">
              <span className="stat-label mb-1">Last Transmission</span>
              <p className="text-[9px] text-secondary-foreground italic">"{selectedAgent.lastMessageSnippet.slice(0, 100)}{selectedAgent.lastMessageSnippet.length > 100 ? '...' : ''}"</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-6 text-slate-600 gap-2">
          <span className="text-2xl opacity-20">?</span>
          <span className="text-[9px] uppercase">Select an agent</span>
        </div>
      )}
    </div>
  );
};

export { AgentPanel };
