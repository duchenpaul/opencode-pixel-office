import { useEffect, useRef, useState } from "react";
import type { Agent } from "../useOfficeState";
import { approvalKey, isAwaitingApproval } from "../lib/activity";

type ApprovalAlertsProps = {
  agents: Agent[];
  onSelectAgent: (agent: Agent) => void;
};

export const playApprovalChime = (context: AudioContext) => {
  const start = context.currentTime;
  [880, 1174].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const time = start + index * 0.15;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.08, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.13);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(time);
    oscillator.stop(time + 0.14);
  });
};

export const ApprovalAlerts = ({ agents, onSelectAgent }: ApprovalAlertsProps) => {
  const [chimesEnabled, setChimesEnabled] = useState(false);
  const [audioError, setAudioError] = useState("");
  const contextRef = useRef<AudioContext | null>(null);
  const seenRef = useRef(new Map<string, Set<string>>());
  const waiting = agents.filter(isAwaitingApproval);

  useEffect(() => {
    const waitingAgents = agents.filter(isAwaitingApproval);
    const waitingIds = new Set(waitingAgents.map((agent) => agent.id));
    let hasNewApproval = false;
    for (const agent of waitingAgents) {
      const seen = seenRef.current.get(agent.id) || new Set<string>();
      const key = approvalKey(agent);
      if (!seen.has(key)) hasNewApproval = true;
      seen.add(key);
      seenRef.current.set(agent.id, seen);
    }
    for (const id of seenRef.current.keys()) {
      if (!waitingIds.has(id)) seenRef.current.delete(id);
    }
    const context = contextRef.current;
    if (!chimesEnabled || !hasNewApproval || !context) return;
    if (context.state !== "running") {
      setAudioError("Audio paused by browser. Re-enable chimes to resume.");
      setChimesEnabled(false);
      return;
    }
    playApprovalChime(context);
  }, [agents, chimesEnabled]);

  useEffect(() => () => {
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch((error: unknown) => console.error("Failed to close approval audio", error));
    }
  }, []);

  const toggleChimes = async () => {
    if (chimesEnabled) {
      setChimesEnabled(false);
      return;
    }
    try {
      if (!window.AudioContext) throw new Error("Web Audio is not supported by this browser.");
      const context = contextRef.current || new AudioContext();
      contextRef.current = context;
      await context.resume();
      if (context.state !== "running") throw new Error("Browser did not allow audio playback.");
      playApprovalChime(context);
      setAudioError("");
      setChimesEnabled(true);
    } catch (error) {
      console.error("Unable to enable approval chimes", error);
      setAudioError(error instanceof Error ? error.message : "Unable to enable approval chimes.");
      setChimesEnabled(false);
    }
  };

  return (
    <div className="approval-controls">
      <button
        type="button"
        className="gamish-btn"
        aria-pressed={chimesEnabled}
        onClick={() => void toggleChimes()}
        title="Play a chime for new approval requests in any office. Off by default."
      >
        Approval chimes: {chimesEnabled ? "on" : "off"}
      </button>
      <div role="status" aria-live="polite">
        {waiting.length > 0 && (
          <div className="approval-requests">
            <span>{waiting.length} awaiting approval</span>
            {waiting.map((agent) => (
              <button key={agent.id} type="button" onClick={() => onSelectAgent(agent)}>
                <strong aria-hidden="true">!</strong>{" "}
                {agent.alias || agent.name || "Agent"}: {agent.approvalTool || "user input"}
                {" "}({agent.source || "opencode"})
              </button>
            ))}
          </div>
        )}
      </div>
      {audioError && <p role="alert" className="approval-audio-error">{audioError}</p>}
    </div>
  );
};
