import importlib.util
import json
import queue
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import Mock, patch


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "plugin/hermes/__init__.py"
        spec = importlib.util.spec_from_file_location("hermes_office_test", source)
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)
        profile = patch.object(self.plugin, "_profile_name", return_value="dev-team", create=True)
        profile.start()
        self.profile_patch = profile
        self.addCleanup(profile.stop)

    def event(self):
        result = self.plugin._events.get_nowait()
        self.plugin._events.task_done()
        return result

    def hook(self, name, **kw):
        self.plugin._observer(name)(**kw)

    def test_registers_non_transforming_hooks(self):
        ctx = Mock()
        with patch.object(self.plugin.threading, "Thread"), \
                patch.object(self.plugin.atexit, "register"), \
                patch.object(self.plugin, "_resolve_endpoint", return_value="http://localhost/events"):
            self.plugin.register(ctx)
        self.assertEqual(ctx.register_hook.call_count, 11)
        for call in ctx.register_hook.call_args_list:
            self.assertIsNone(call.args[1](unexpected_future_field=True))

    def test_session_tool_approval_and_end_contract(self):
        self.hook("on_session_start", session_id="one", cwd="/work/repo", model="test-model")
        start = self.event()
        self.assertEqual(start["source"], "hermes")
        self.assertEqual(start["type"], "session.created")
        self.assertEqual(start["properties"]["info"]["directory"], "/work/repo")
        self.hook("pre_tool_call", session_id="one", tool_name="terminal",
                  args={"command": "test"}, future_field=1)
        self.assertEqual(self.event()["properties"]["preview"], "test")
        self.hook("pre_approval_request", command="test")
        self.assertEqual(self.event()["properties"]["sessionID"], "one")
        self.hook("post_approval_response", choice="allow")
        self.assertEqual(self.event()["type"], "permission.replied")
        self.hook("post_tool_call", session_id="one", tool_name="terminal", status="ok")
        self.assertEqual(self.event()["properties"]["status"], "thinking")
        self.hook("on_session_end", session_id="one")
        self.assertEqual(self.event()["type"], "session.deleted")
        self.assertFalse(self.plugin._sessions)
        self.assertFalse(self.plugin._tools)

    def test_runtime_metadata_uses_profile_and_actual_request_provider(self):
        self.hook("on_session_start", session_id="one", model="test-model")
        info = self.event()["properties"]["info"]
        self.assertEqual(info["agent"], "dev-team")
        self.assertEqual(info["profile"], "dev-team")
        self.assertEqual(info["directory"], str(Path.cwd()))
        self.assertEqual(info["model"]["modelID"], "test-model")
        self.hook("pre_api_request", session_id="one", model="switched-model",
                  provider="openrouter", base_url="https://example.invalid",
                  api_key="must-not-be-forwarded", conversation_history=[])
        request = self.event()
        self.assertEqual(request["type"], "session.updated")
        self.assertEqual(request["properties"]["info"]["model"],
                         {"modelID": "switched-model", "providerID": "openrouter"})
        self.assertNotIn("must-not-be-forwarded", json.dumps(request))
        self.hook("pre_tool_call", session_id="one", tool_name="terminal")
        info = self.event()["properties"]["info"]
        self.assertEqual(info["agent"], "dev-team")
        self.assertEqual(info["model"]["providerID"], "openrouter")

    def test_profile_resolver_uses_hermes_profile_api(self):
        self.profile_patch.stop()
        profiles = Mock()
        profiles.get_active_profile_name.return_value = "dev-team"
        with patch.dict("sys.modules", {"hermes_cli.profiles": profiles}):
            self.assertEqual(self.plugin._profile_name(), "dev-team")

    def test_todos_follow_authoritative_results_not_partial_merge_arguments(self):
        items = [{"id": "1", "content": "Investigate", "status": "completed"},
                 {"id": "2", "content": "Fix mapping", "status": "in_progress"}]
        self.hook("post_tool_call", session_id="one", tool_name="todo",
                  args={"todos": [{"id": "1", "status": "completed"}], "merge": True},
                  result=json.dumps({"todos": items}))
        self.assertEqual(self.event()["type"], "tool.execute.after")
        todos = self.event()
        self.assertEqual(todos["type"], "todo.updated")
        self.assertEqual(todos["properties"]["todos"], items)
        self.assertEqual(todos["properties"]["sessionID"], "one")
        self.hook("post_tool_call", session_id="one", tool_name="todo",
                  result=json.dumps({"todos": items}))
        self.event()
        self.assertTrue(self.plugin._events.empty())
        self.hook("post_tool_call", session_id="two", tool_name="todo",
                  result={"todos": []})
        self.event()
        self.assertEqual(self.event()["properties"]["todos"], [])
        with self.assertLogs(self.plugin.logger, level="WARNING"):
            self.hook("post_tool_call", session_id="one", tool_name="todo", result="invalid")
        self.event()
        self.assertTrue(self.plugin._events.empty())

    def test_agent_loop_todos_sync_from_history_without_post_tool_hook(self):
        items = [{"id": "1", "content": "Finish", "status": "completed"}]
        history = [
            {"role": "assistant", "tool_calls": [
                {"id": "todo-call", "function": {"name": "todo"}}]},
            {"role": "tool", "tool_call_id": "todo-call",
             "content": json.dumps({"todos": items})},
            {"role": "tool", "name": "terminal", "content": '{"todos": []}'},
        ]
        self.hook("pre_api_request", session_id="one", model="test-model",
                  provider="nous", conversation_history=history)
        self.assertEqual(self.event()["type"], "session.updated")
        self.assertEqual(self.event()["properties"]["todos"], items)
        self.hook("post_llm_call", session_id="one", conversation_history=history)
        self.assertEqual(self.event()["type"], "session.idle")
        self.assertTrue(self.plugin._events.empty())
        history.append({"role": "tool", "name": "todo", "content": '{"todos": []}'})
        self.hook("pre_llm_call", session_id="one", conversation_history=history)
        self.assertEqual(self.event()["type"], "session.updated")
        self.assertEqual(self.event()["properties"]["todos"], [])
        self.hook("on_session_end", session_id="one")
        self.event()
        self.assertFalse(self.plugin._todo_snapshots)

    def test_children_keep_identity_metadata_and_are_forgotten_with_parent(self):
        self.hook("on_session_start", session_id="parent", cwd="/work/parent")
        self.event()
        self.hook("subagent_start", session_id="parent", child_session_id="child",
                  parent_session_id="parent", child_role="research", child_goal="Investigate")
        child = self.event()["properties"]
        self.assertEqual(child["sessionID"], "child")
        self.assertEqual(child["parentSessionId"], "parent")
        self.assertEqual(child["info"]["profile"], "dev-team")
        self.assertEqual(child["info"]["directory"], "/work/parent")
        self.hook("pre_tool_call", session_id="child", tool_name="read_file")
        tool = self.event()["properties"]
        self.assertEqual(tool["info"]["agent"], "research")
        self.assertEqual(tool["info"]["parentSessionId"], "parent")
        self.hook("subagent_stop", child_session_id="child")
        self.assertEqual(self.event()["properties"]["sessionID"], "child")
        self.assertNotIn("child", self.plugin._sessions)
        self.hook("subagent_start", child_session_id="second", parent_session_id="parent")
        self.event()
        self.hook("on_session_end", session_id="parent")
        self.event()
        self.assertFalse(self.plugin._sessions)

    def test_ambiguous_approvals_are_logged_not_misattributed(self):
        for sid in ("one", "two"):
            self.hook("pre_tool_call", session_id=sid, tool_name="terminal")
            self.event()
        with self.assertLogs(self.plugin.logger, level="WARNING"):
            self.hook("pre_approval_request")
        self.assertTrue(self.plugin._events.empty())
        self.hook("pre_approval_request", session_id="two")
        self.assertEqual(self.event()["properties"]["sessionID"], "two")

    def test_error_and_malformed_callbacks_never_raise(self):
        self.hook("post_tool_call", session_id="one", status="error", error_message="failed")
        self.assertEqual(self.event()["properties"]["status"], "error")
        with self.assertLogs(self.plugin.logger, level="WARNING"):
            self.hook("on_session_start")
        with patch.object(self.plugin, "_handle", side_effect=RuntimeError("bad payload")), \
                self.assertLogs(self.plugin.logger, level="ERROR"):
            self.assertIsNone(self.plugin._observer("pre_tool_call")(session_id="one"))

    def test_concurrent_sessions_attribute_approvals_to_their_tool_threads(self):
        barrier = threading.Barrier(2)

        def run(sid):
            self.hook("pre_tool_call", session_id=sid, tool_name="terminal")
            barrier.wait(timeout=5)
            self.hook("pre_approval_request")
            barrier.wait(timeout=5)
            self.hook("post_tool_call", session_id=sid, tool_name="terminal")

        threads = [threading.Thread(target=run, args=(sid,)) for sid in ("one", "two")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=6)
            self.assertFalse(thread.is_alive())
        events = [self.event() for _ in range(6)]
        approvals = [event["properties"]["sessionID"] for event in events
                     if event["type"] == "permission.asked"]
        self.assertEqual(set(approvals), {"one", "two"})
        self.assertFalse(self.plugin._tools)

    def test_bounded_queue_never_blocks_and_logs_overflow(self):
        self.plugin._events = queue.Queue(maxsize=1)
        self.hook("on_session_start", session_id="one")
        with self.assertLogs(self.plugin.logger, level="WARNING"):
            self.hook("on_session_start", session_id="two")
        self.assertEqual(self.plugin._events.qsize(), 1)

    def test_endpoint_override_saved_port_and_invalid_configuration(self):
        with tempfile.TemporaryDirectory() as home, \
                patch.object(self.plugin.Path, "home", return_value=Path(home)), \
                patch.dict(self.plugin.os.environ, {}, clear=True):
            self.assertEqual(self.plugin._resolve_endpoint(), "http://127.0.0.1:5100/events")
            config = Path(home) / ".opencode/pixel-office/config.json"
            config.parent.mkdir(parents=True)
            config.write_text('{"port": 5432}')
            self.assertEqual(self.plugin._resolve_endpoint(), "http://127.0.0.1:5432/events")
            with patch.dict(self.plugin.os.environ, {"PIXEL_OFFICE_URL": "http://custom/events"}):
                self.assertEqual(self.plugin._resolve_endpoint(), "http://custom/events")
            config.write_text('{"port": false}')
            with self.assertRaises(ValueError):
                self.plugin._resolve_endpoint()
            with self.assertLogs(self.plugin.logger, level="ERROR"):
                ctx = Mock()
                self.plugin.register(ctx)
            ctx.register_hook.assert_not_called()

    def test_actual_http_delivery_and_network_timeout(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(202)
                self.end_headers()

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            self.plugin._endpoint = f"http://127.0.0.1:{server.server_port}/events"
            self.hook("on_session_start", session_id="one")
            event = self.event()
            self.plugin._deliver(event)
            self.assertEqual(received, [event])
        finally:
            server.shutdown()
            worker.join()
            server.server_close()
        with patch.object(self.plugin.urllib.request, "urlopen", side_effect=TimeoutError) as send:
            with self.assertRaises(TimeoutError):
                self.plugin._deliver(event)
            self.assertEqual(send.call_args.kwargs["timeout"], 1)

    def test_worker_logs_delivery_failure_and_continues(self):
        self.hook("on_session_start", session_id="one")
        original_get = self.plugin._events.get
        with patch.object(self.plugin._events, "get", side_effect=[original_get(), SystemExit]), \
                patch.object(self.plugin, "_deliver", side_effect=OSError("offline")), \
                self.assertLogs(self.plugin.logger, level="WARNING"):
            with self.assertRaises(SystemExit):
                self.plugin._drain()
        self.assertEqual(self.plugin._events.unfinished_tasks, 0)


if __name__ == "__main__":
    unittest.main()
