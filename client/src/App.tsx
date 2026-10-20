import { useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { AgentPanel } from "./components/AgentPanel";
import { ScreenFrame } from "./components/ScreenFrame";
import { SessionPanel } from "./components/SessionPanel";
import { TodoPanel } from "./components/TodoPanel";
import { useOfficeState } from "./useOfficeState";
import type { OfficeSource } from "./useOfficeState";
import { formatSessionName } from "./lib/session";
import { ApprovalAlerts } from "./components/ApprovalAlerts";
import { getHermesProfiles, matchesHermesProfile, UNPROFILED_HERMES } from "./lib/hermes";

type OfficeTab = OfficeSource;

const App = () => {
  const {
    agents,
    sessions,
    todos,
    interactions,
    connected,
    activeSessionId,
    selectedSessionId,
    selectedAgentId,
    appVersion,
    lastTodoSummary,
    bossMessage,
    networkIp,
    hermesProfiles,
    hermesDefaultProfile,
    setSelectedAgentId,
    setSelectedSessionId,
  } = useOfficeState();

  const [showQr, setShowQr] = useState(false);
  const [selectedTab, setSelectedTab] = useState<OfficeTab | null>(null);
  const [selectedHermesProfile, setSelectedHermesProfile] = useState<string | null>(null);
  const activeHermesProfile = selectedHermesProfile ?? hermesDefaultProfile;
  const profileOptions = useMemo(
    () => getHermesProfiles(hermesProfiles, activeHermesProfile === UNPROFILED_HERMES
      ? hermesDefaultProfile : activeHermesProfile || hermesDefaultProfile, agents, sessions),
    [hermesProfiles, hermesDefaultProfile, activeHermesProfile, agents, sessions]
  );
  const hasUnprofiledHermes = agents.some((a) => a.source === "hermes" && !a.profile)
    || sessions.some((s) => s.source === "hermes" && !s.profile);

  // Count agents per tab for badges
  const opencodeCount = useMemo(
    () => agents.filter((a) => (a.source || "opencode") === "opencode").length,
    [agents]
  );
  const claudeCount = useMemo(
    () => agents.filter((a) => a.source === "claude").length,
    [agents]
  );
  const hermesCount = useMemo(
    () => agents.filter((a) => a.source === "hermes").length,
    [agents]
  );
  const hermesProfileCount = useMemo(
    () => agents.filter((a) => a.source === "hermes" && matchesHermesProfile(a, activeHermesProfile)).length,
    [agents, activeHermesProfile]
  );
  const activeTab = selectedTab ?? (
    opencodeCount >= claudeCount && opencodeCount >= hermesCount
      ? "opencode"
      : claudeCount >= hermesCount ? "claude" : "hermes"
  );

  // Filter agents by source
  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      const source = agent.source || "opencode";
      return source === activeTab && (source !== "hermes" || matchesHermesProfile(agent, activeHermesProfile));
    });
  }, [agents, activeTab, activeHermesProfile]);

  const filteredSessions = useMemo(
    () => sessions.filter((session) => (session.source || "opencode") === activeTab
      && (activeTab !== "hermes" || matchesHermesProfile(session, activeHermesProfile))),
    [sessions, activeTab, activeHermesProfile]
  );
  const selectedSession = filteredSessions.find((session) => session.id === selectedSessionId)
    || filteredSessions.find((session) => session.id === activeSessionId)
    || filteredSessions[0]
    || null;
  const selectedAgent = filteredAgents.find((agent) => agent.id === selectedAgentId) || null;
  const alertAgents = useMemo(
    () => agents.filter((agent) => agent.source !== "hermes" || matchesHermesProfile(agent, activeHermesProfile)),
    [agents, activeHermesProfile]
  );
  const useLegacyTodos = activeTab !== "hermes" && selectedSession?.id === activeSessionId;
  const sessionTodos = selectedSession?.todos ?? (useLegacyTodos ? todos : []);
  const sessionTodoSummary = selectedSession?.lastTodoSummary
    ?? (useLegacyTodos ? lastTodoSummary : null);

  const selectAgent = (id: string | null) => {
    setSelectedAgentId(id);
    const sessionId = filteredAgents.find((agent) => agent.id === id)?.sessionId;
    if (sessionId) setSelectedSessionId(sessionId);
  };
  const selectSession = (id: string | null) => {
    setSelectedSessionId(id);
    setSelectedAgentId(filteredAgents.find((agent) => agent.sessionId === id)?.id || null);
  };

  // Filter interactions to only include agents in the current tab
  const filteredInteractions = useMemo(() => {
    const agentIds = new Set(filteredAgents.map((a) => a.id));
    return interactions.filter(
      (i) => agentIds.has(i.from) || agentIds.has(i.to)
    );
  }, [interactions, filteredAgents]);

  const activeSession = filteredSessions.find((session) => session.id === activeSessionId)
    || selectedSession;
  const activeLabel = activeSession ? formatSessionName(activeSession) : "N/A";
  const version = appVersion ? `v${appVersion}` : "v1.0.0";
  const todoSummary = sessionTodoSummary
    ? `${sessionTodoSummary.completed}/${sessionTodoSummary.total}`
    : "0/0";
  const bossMessageText = bossMessage?.text || "Awaiting mission updates...";
  const bossStatus = bossMessage?.status ? bossMessage.status.toUpperCase() : "IDLE";

  return (
    <div className="app">
      <header>
        <div className="gamish-card logo-card">
          <div className="flex flex-col">
            <h1 className="text-sm text-primary mb-1 tracking-widest">PIXEL OFFICE</h1>
            <p className="text-[9px] text-muted-foreground">AI AGENT OPS // {version}</p>
          </div>
        </div>

        {/* Office Tabs */}
        <div className="flex gap-1">
          <button
            onClick={() => setSelectedTab("opencode")}
            className={`office-tab ${activeTab === "opencode" ? "active" : ""}`}
          >
            <span className="tab-icon">◈</span>
            <span>OpenCode</span>
            {opencodeCount > 0 && (
              <span className="tab-badge">{opencodeCount}</span>
            )}
          </button>
          <button
            onClick={() => setSelectedTab("claude")}
            className={`office-tab ${activeTab === "claude" ? "active" : ""}`}
          >
            <span className="tab-icon">◇</span>
            <span>Claude</span>
            {claudeCount > 0 && (
              <span className="tab-badge">{claudeCount}</span>
            )}
          </button>
          <button
            onClick={() => setSelectedTab("hermes")}
            className={`office-tab ${activeTab === "hermes" ? "active" : ""}`}
          >
            <span className="tab-icon">H</span>
            <span>Hermes</span>
            {hermesProfileCount > 0 && (
              <span className="tab-badge">{hermesProfileCount}</span>
            )}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <div className={`status-badge ${connected ? "live" : ""}`}>
            <span className="text-[8px] opacity-70 mb-1">SYSTEM STATUS</span>
            <span className="font-bold">{connected ? "ONLINE" : "OFFLINE"}</span>
            {networkIp && connected && (
              <div className="relative mt-2 border-t border-white/20 pt-1 flex flex-col items-center">
                <button
                  onClick={() => setShowQr(!showQr)}
                  className="text-[8px] font-normal opacity-80 hover:opacity-100 hover:text-accent cursor-pointer underline decoration-dotted"
                  title="Click to scan QR code"
                >
                  http://{networkIp}:5100
                </button>

                {showQr && (
                  <div className="absolute top-8 right-0 bg-white p-2 border-2 border-foreground shadow-[4px_4px_0_rgba(0,0,0,0.2)] z-50">
                    <div style={{ height: "auto", margin: "0 auto", maxWidth: 128, width: "100%" }}>
                      <QRCode
                        size={256}
                        style={{ height: "auto", maxWidth: "100%", width: "100%" }}
                        value={`http://${networkIp}:5100`}
                        viewBox={`0 0 256 256`}
                      />
                    </div>
                    <div className="text-[8px] text-center mt-1 text-foreground font-bold">SCAN ME</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <label
            className={`flex flex-col gap-1 text-[9px] text-secondary-foreground ${activeTab === "hermes" ? "" : "invisible"}`}
            aria-hidden={activeTab !== "hermes"}
          >
            <span>Hermes profile</span>
            <select
              aria-label="Hermes profile"
              disabled={activeTab !== "hermes"}
              className="bg-secondary border border-border rounded p-1.5 text-secondary-foreground"
              value={activeHermesProfile}
              onChange={(event) => {
                setSelectedHermesProfile(event.target.value);
                setSelectedAgentId(null);
                setSelectedSessionId(null);
              }}
            >
              <option value="">All profiles</option>
              {profileOptions.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
              {(hasUnprofiledHermes || activeHermesProfile === UNPROFILED_HERMES) && (
                <option value={UNPROFILED_HERMES}>Unspecified profile</option>
              )}
            </select>
          </label>
        </div>
      </header>

      <ApprovalAlerts
        agents={alertAgents}
        onSelectAgent={(agent) => {
          setSelectedTab(agent.source || "opencode");
          setSelectedAgentId(agent.id);
          if (agent.source === "hermes") setSelectedHermesProfile(agent.profile || UNPROFILED_HERMES);
          if (agent.sessionId) setSelectedSessionId(agent.sessionId);
        }}
      />

      <main>
        <ScreenFrame
          bossMessageText={bossMessageText}
          bossStatus={bossStatus}
          agents={filteredAgents}
          interactions={filteredInteractions}
          sessions={filteredSessions}
          activeSessionId={activeSession?.id || null}
          lastTodoSummary={sessionTodoSummary}
          selectedAgentId={selectedAgentId}
          onSelectAgent={selectAgent}
          activeTab={activeTab}
        />

        <aside className="sidebar-stack">
          {activeTab === "hermes" && filteredSessions.length === 0 && (
            <p role="status" className="data-panel text-[9px] text-secondary-foreground">
              No live Hermes sessions{activeHermesProfile && activeHermesProfile !== UNPROFILED_HERMES
                ? ` for ${activeHermesProfile}` : ""}.
              {" "}Enable Pixel Office in that profile, restart Hermes, and send a prompt.
            </p>
          )}
          <SessionPanel
            sessions={filteredSessions}
            activeLabel={activeLabel}
            version={version}
            todoSummary={todoSummary}
            selectedSessionId={selectedSession?.id || null}
            selectedSession={selectedSession}
            onSelectSession={selectSession}
          />
          <TodoPanel todos={sessionTodos} />
          <AgentPanel selectedAgent={selectedAgent} sessions={filteredSessions} />
        </aside>
      </main>
    </div>
  );
};

export default App;
