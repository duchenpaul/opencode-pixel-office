"""Non-blocking Hermes observers for the shared Pixel Office server."""

import atexit
import http.client
import json
import logging
import os
import queue
import threading
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)
_events: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=256)
_lock = threading.RLock()
_sessions: dict[str, dict[str, Any]] = {}
_tools: dict[tuple[int, str, str], int] = {}
_worker: threading.Thread | None = None
_endpoint = ""


def _resolve_endpoint() -> str:
    override = os.environ.get("PIXEL_OFFICE_URL")
    if override:
        return override
    config_path = Path.home() / ".opencode" / "pixel-office" / "config.json"
    port = 5100
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        port = config.get("port", port)
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError(f"Invalid Pixel Office port in {config_path}")
    return f"http://127.0.0.1:{port}/events"


def _deliver(event: dict[str, Any]) -> None:
    request = urllib.request.Request(
        _endpoint,
        data=json.dumps(event).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=1) as response:
        if response.status != 202:
            raise OSError(f"Unexpected Pixel Office response: {response.status}")


def _drain() -> None:
    while True:
        event = _events.get()
        try:
            _deliver(event)
        except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException) as exc:
            logger.warning("Pixel Office event delivery failed: %s", exc)
        finally:
            _events.task_done()


def _publish(kind: str, sid: str, **properties: Any) -> None:
    if not sid:
        logger.warning("Pixel Office skipped %s: missing session identifier", kind)
        return
    info = {**_sessions.get(sid, {}), "id": sid, "sessionID": sid}
    event = {
        "source": "hermes",
        "type": kind,
        "properties": {"info": info, "sessionID": sid, **properties},
    }
    try:
        _events.put_nowait(event)
    except queue.Full:
        logger.warning("Pixel Office event queue full; dropped %s for %s", kind, sid)


def _remember(sid: str, kw: dict[str, Any]) -> None:
    info = _sessions.setdefault(sid, {"agent": "Hermes"})
    for source, target in (("cwd", "directory"), ("directory", "directory"),
                           ("title", "title"), ("child_role", "agent"),
                           ("child_role", "role"), ("child_goal", "title")):
        if kw.get(source):
            info[target] = str(kw[source])
    model = kw.get("model")
    if isinstance(model, str) and model:
        info["model"] = {"modelID": model}
    elif isinstance(model, dict):
        info["model"] = {
            key: model[key] for key in ("modelID", "providerID")
            if isinstance(model.get(key), str) and model[key]
        }


def _approval_session(kw: dict[str, Any]) -> str:
    if kw.get("session_id"):
        return str(kw["session_id"])
    local = {sid for (thread, sid, _), count in _tools.items()
             if thread == threading.get_ident() and count}
    candidates = local or {sid for (_, sid, _), count in _tools.items() if count}
    if len(candidates) == 1:
        return next(iter(candidates))
    logger.warning("Pixel Office skipped approval: no unambiguous active session")
    return ""


def _forget(sid: str) -> None:
    children = [child for child, info in _sessions.items()
                if info.get("parentSessionId") == sid]
    for child in children:
        _forget(child)
    _sessions.pop(sid, None)
    for key in list(_tools):
        if key[1] == sid:
            del _tools[key]


def _handle(hook: str, kw: dict[str, Any]) -> None:
    sid = str((kw.get("child_session_id") if hook.startswith("subagent_")
               else kw.get("session_id")) or "")
    if "approval" in hook:
        sid = _approval_session(kw)
    if not sid:
        logger.warning("Pixel Office skipped %s: missing session identifier", hook)
        return
    _remember(sid, kw)
    if hook == "on_session_start":
        _publish("session.created", sid)
    elif hook in ("on_session_end", "subagent_stop"):
        _publish("session.deleted", sid)
        _forget(sid)
    elif hook == "subagent_start":
        parent = str(kw.get("parent_session_id") or "")
        _sessions[sid]["parentSessionId"] = parent
        _publish("session.created", sid, parentSessionId=parent, status="working")
    elif hook == "pre_tool_call":
        name = str(kw.get("tool_name") or "")
        key = (threading.get_ident(), sid, name)
        _tools[key] = _tools.get(key, 0) + 1
        args = kw.get("args")
        preview = ""
        if isinstance(args, dict):
            preview = next((str(args[k])[:200] for k in
                            ("command", "path", "query", "url", "goal", "pattern", "prompt")
                            if args.get(k)), "")
        _publish("tool.execute.before", sid, tool={"name": name}, preview=preview)
    elif hook == "post_tool_call":
        name = str(kw.get("tool_name") or "")
        key = (threading.get_ident(), sid, name)
        if key in _tools:
            _tools[key] -= 1
            if not _tools[key]:
                del _tools[key]
        failed = kw.get("status") in ("error", "failed", "failure") or kw.get("error_message")
        _publish("tool.execute.after", sid, tool={"name": name},
                 status="error" if failed else "thinking",
                 preview=str(kw.get("error_message") or "")[:200])
    elif hook == "pre_approval_request":
        _publish("permission.asked", sid, preview="Awaiting approval")
    elif hook == "post_approval_response":
        choice = str(kw.get("choice") or "")
        _publish("permission.replied", sid, preview=f"Approval response: {choice}"[:200])


def _observer(hook: str) -> Any:
    def callback(**kwargs: Any) -> None:
        try:
            with _lock:
                _handle(hook, kwargs)
        except Exception:
            # Hermes observers must not interrupt tool execution, even on malformed payloads.
            logger.exception("Pixel Office observer failed for %s", hook)
    return callback


def _flush() -> None:
    if _worker is None:
        return
    # Give normal session-end events a chance to leave without delaying shutdown indefinitely.
    import time
    deadline = time.monotonic() + 1.2
    while _events.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.01)
    if _events.unfinished_tasks:
        logger.warning("Pixel Office exiting with %s undelivered events", _events.unfinished_tasks)


def register(ctx: Any) -> None:
    global _worker, _endpoint
    try:
        _endpoint = _resolve_endpoint()
        url = urllib.parse.urlsplit(_endpoint)
        if url.scheme not in ("http", "https") or not url.hostname or any(c.isspace() for c in _endpoint):
            raise ValueError("PIXEL_OFFICE_URL must be an HTTP(S) URL")
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        logger.error("Pixel Office plugin not started: %s", exc)
        return
    if _worker is None:
        _worker = threading.Thread(target=_drain, name="pixel-office", daemon=True)
        _worker.start()
        atexit.register(_flush)
    for hook in ("on_session_start", "on_session_end", "pre_tool_call", "post_tool_call",
                 "subagent_start", "subagent_stop", "pre_approval_request",
                 "post_approval_response"):
        ctx.register_hook(hook, _observer(hook))
    logger.info("Pixel Office observers registered: %s", _endpoint)
