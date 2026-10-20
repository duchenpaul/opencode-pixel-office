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
_todo_snapshots: dict[str, list[dict[str, str]]] = {}
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


def _enqueue(event: dict[str, Any]) -> None:
    try:
        _events.put_nowait(event)
    except queue.Full:
        logger.warning("Pixel Office event queue full; dropped %s", event["type"])


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
    _enqueue(event)


def _profile_name() -> str:
    try:
        from hermes_cli.profiles import get_active_profile_name
        return str(get_active_profile_name())
    except ImportError as exc:
        logger.warning("Pixel Office could not resolve the Hermes profile: %s", exc)
        return ""


def _publish_profile() -> None:
    try:
        current = _profile_name()
        if current:
            _enqueue({
                "source": "hermes",
                "type": "hermes.profile",
                "properties": {"profile": current},
            })
    except (ImportError, OSError, ValueError) as exc:
        logger.warning("Pixel Office could not report the active Hermes profile: %s", exc)


def _publish_profiles() -> None:
    try:
        try:
            from hermes_cli.profiles import list_profiles
            names = {profile.name for profile in list_profiles()}
        except Exception as exc:
            logger.debug("Pixel Office scanning Hermes profile directories after discovery failed: %s", exc)
            try:
                from hermes_cli.profiles import _get_profiles_root
                root = Path(_get_profiles_root())
            except Exception as exc:
                logger.debug("Pixel Office using the standard Hermes profiles directory: %s", exc)
                root = Path.home() / ".hermes" / "profiles"
            names = {"default"}
            if root.is_dir():
                names.update(entry.name for entry in root.iterdir() if entry.is_dir())
        current = _profile_name()
        if current:
            names.add(current)
        _enqueue({
            "source": "hermes",
            "type": "hermes.profiles",
            "properties": {"profiles": sorted(names)},
        })
    except (ImportError, OSError, ValueError) as exc:
        logger.warning("Pixel Office could not discover Hermes profiles: %s", exc)


def _remember(sid: str, kw: dict[str, Any]) -> None:
    if sid not in _sessions:
        parent = _sessions.get(str(kw.get("parent_session_id") or ""), {})
        profile = str(kw.get("profile") or parent.get("profile") or _profile_name())
        _sessions[sid] = {
            "agent": profile or "Hermes",
            "profile": profile,
            "directory": parent.get("directory") or os.getcwd(),
        }
    info = _sessions[sid]
    for source, target in (("cwd", "directory"), ("directory", "directory"),
                           ("title", "title"), ("child_role", "agent"),
                           ("child_role", "role"), ("child_goal", "title")):
        if kw.get(source):
            info[target] = str(kw[source])
    model_info = dict(info.get("model", {}))
    model = kw.get("model")
    if isinstance(model, str) and model:
        model_info["modelID"] = model
    elif isinstance(model, dict):
        model_info.update({
            key: model[key] for key in ("modelID", "providerID")
            if isinstance(model.get(key), str) and model[key]
        })
    provider = kw.get("provider")
    if isinstance(provider, str) and provider:
        model_info["providerID"] = provider
    if model_info:
        info["model"] = model_info


def _sync_todos(sid: str, result: Any) -> None:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            logger.warning("Pixel Office skipped malformed todo result for %s", sid)
            return
    if not isinstance(result, dict) or not isinstance(result.get("todos"), list):
        logger.warning("Pixel Office skipped todo result without a task list for %s", sid)
        return
    todos: list[dict[str, str]] = []
    for item in result["todos"]:
        if (not isinstance(item, dict)
                or not all(isinstance(item.get(key), str) for key in ("id", "content", "status"))
                or item["status"] not in ("pending", "in_progress", "completed", "cancelled")):
            logger.warning("Pixel Office skipped invalid todo items for %s", sid)
            return
        todos.append({key: item[key] for key in ("id", "content", "status")})
    if _todo_snapshots.get(sid) != todos:
        _todo_snapshots[sid] = todos
        _publish("todo.updated", sid, todos=todos)


def _sync_history_todos(sid: str, history: Any) -> None:
    if not isinstance(history, list):
        return
    todo_calls = set()
    for message in history:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if (isinstance(call, dict) and isinstance(call.get("function"), dict)
                    and call["function"].get("name") == "todo" and isinstance(call.get("id"), str)):
                todo_calls.add(call["id"])
    for message in reversed(history):
        if (isinstance(message, dict) and message.get("role") == "tool"
                and (message.get("name") == "todo"
                     or message.get("tool_call_id") in todo_calls)):
            _sync_todos(sid, message.get("content"))
            return


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
    _todo_snapshots.pop(sid, None)
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
    if hook in ("on_session_start", "on_session_reset"):
        _publish("session.created", sid)
    elif hook in ("pre_llm_call", "pre_api_request", "post_llm_call"):
        _publish("session.idle" if hook == "post_llm_call" else "session.updated", sid)
        # Hermes handles todo inside the agent loop, bypassing post_tool_call.
        _sync_history_todos(sid, kw.get("conversation_history"))
    elif hook in ("on_session_end", "on_session_finalize"):
        _publish("session.idle", sid)
        for key in list(_tools):
            if key[1] == sid:
                del _tools[key]
    elif hook == "subagent_stop":
        _publish("session.deleted", sid)
        _forget(sid)
    elif hook == "subagent_start":
        parent = str(kw.get("parent_session_id") or "")
        _sessions[sid]["parentSessionId"] = parent
        _publish("session.created", sid, parentSessionId=parent)
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
        extra = {"status": "error"} if failed else {}
        _publish("tool.execute.after", sid, tool={"name": name},
                 preview=str(kw.get("error_message") or "")[:200], **extra)
        if name == "todo" and not failed:
            _sync_todos(sid, kw.get("result"))
    elif hook == "pre_approval_request":
        _publish("permission.asked", sid, preview="Awaiting approval")
    elif hook == "post_approval_response":
        choice = str(kw.get("choice") or "")
        _publish("permission.replied", sid, choice=choice,
                 preview=f"Approval response: {choice}"[:200])


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
    with _lock:
        for sid in _sessions:
            _publish("session.deleted", sid)
        _sessions.clear()
        _todo_snapshots.clear()
        _tools.clear()
    # Give exit events a chance to leave without delaying shutdown indefinitely.
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
    for hook in ("on_session_start", "on_session_end", "on_session_finalize", "on_session_reset",
                 "pre_tool_call", "post_tool_call",
                 "subagent_start", "subagent_stop", "pre_approval_request",
                 "post_approval_response", "pre_llm_call", "pre_api_request", "post_llm_call"):
        ctx.register_hook(hook, _observer(hook))
    _publish_profile()
    _publish_profiles()
    logger.info("Pixel Office observers registered: %s", _endpoint)
