from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from unittest.mock import patch

from mirror_host_agent.__main__ import (
    CONTROL_GRANT_TTL_MS,
    AgentConfig,
    M0Agent,
    SyntheticVideoTrack,
)
from mirror_host_agent.input_control import FakeInputSink, InputController


class SyntheticVideoTrackTests(unittest.TestCase):
    def test_creates_a_720p_frame(self) -> None:
        track = SyntheticVideoTrack()

        frame = asyncio.run(track.recv())

        self.assertEqual(frame.width, 1280)
        self.assertEqual(frame.height, 720)
        self.assertEqual(frame.time_base.numerator, 1)
        self.assertEqual(frame.time_base.denominator, 90_000)


class ControlProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used-in-unit-test",
                ws_url="ws://127.0.0.1:8787/ws",
            )
        )

    def test_echoes_a_strict_ping_as_pong(self) -> None:
        pong = self.agent._create_pong(
            '{"data":{},"event":"session.ping","sequence":7,'
            '"sessionId":"session_0123456789abcdef",'
            '"timestamp":1234,"version":1}'
        )

        self.assertEqual(pong["event"] if pong else None, "session.pong")
        self.assertEqual(pong["timestamp"] if pong else None, 1234)

    def test_rejects_command_shaped_or_wrong_session_messages(self) -> None:
        command = self.agent._create_pong(
            '{"command":"powershell","data":{},"event":"session.ping",'
            '"sequence":7,"sessionId":"session_0123456789abcdef",'
            '"timestamp":1234,"version":1}'
        )
        wrong_session = self.agent._create_pong(
            '{"data":{},"event":"session.ping","sequence":7,'
            '"sessionId":"session_wrong_0123456789",'
            '"timestamp":1234,"version":1}'
        )

        self.assertIsNone(command)
        self.assertIsNone(wrong_session)

    def test_rejects_stale_future_and_boolean_control_metadata(self) -> None:
        def control(timestamp: object, sequence: object = 8) -> str:
            return json.dumps(
                {
                    "data": {"code": "KeyA"},
                    "event": "key.down",
                    "sequence": sequence,
                    "sessionId": "session_0123456789abcdef",
                    "timestamp": timestamp,
                    "version": 1,
                }
            )

        with patch("mirror_host_agent.__main__.time.time", return_value=1000.0):
            self.assertIsNotNone(self.agent._parse_control(control(1_000_000)))
            self.assertIsNone(self.agent._parse_control(control(900_000)))
            self.assertIsNone(self.agent._parse_control(control(1_100_000)))
            self.assertIsNone(self.agent._parse_control(control(1_000_000, True)))
            self.assertIsNone(self.agent._parse_control(control(True)))


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))


class _FakeSender:
    def __init__(self) -> None:
        self.tracks: list[object] = []

    def replaceTrack(self, track: object) -> None:
        self.tracks.append(track)


class ControlGrantTests(unittest.IsolatedAsyncioTestCase):
    async def _request_permission(
        self, *, control_enabled: bool, permission: str
    ) -> tuple[M0Agent, dict]:
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                control_enabled=control_enabled,
            )
        )
        websocket = _FakeWebSocket()
        request = json.dumps(
            {
                "payload": {
                    "deviceId": "device_0123456789abcdef",
                    "permission": permission,
                },
                "sequence": 1,
                "sessionId": "session_0123456789abcdef",
                "type": "session.request",
                "version": 1,
            }
        )
        await agent._handle_message(websocket, request)
        accept = next(m for m in websocket.sent if m["type"] == "session.accept")
        return agent, accept

    async def test_view_request_grants_view(self) -> None:
        agent, accept = await self._request_permission(
            control_enabled=True, permission="view"
        )
        self.assertEqual(accept["payload"]["permission"], "view")
        self.assertFalse(agent._granted_control)

    async def test_control_denied_when_local_policy_disabled(self) -> None:
        agent, accept = await self._request_permission(
            control_enabled=False, permission="control"
        )
        self.assertEqual(accept["payload"]["permission"], "view")
        self.assertFalse(agent._granted_control)

    async def test_control_denied_when_input_backend_preflight_fails(self) -> None:
        with patch(
            "mirror_host_agent.windows_input.create_input_sink",
            side_effect=OSError("backend unavailable"),
        ):
            agent, accept = await self._request_permission(
                control_enabled=True, permission="control"
            )
        self.assertEqual(accept["payload"]["permission"], "view")
        self.assertFalse(agent._granted_control)

    @unittest.skipUnless(sys.platform == "win32", "control injection is Windows-only")
    async def test_control_granted_when_enabled_on_windows(self) -> None:
        with patch("mirror_host_agent.__main__.time.time", return_value=1000.0):
            agent, accept = await self._request_permission(
                control_enabled=True, permission="control"
            )
        self.assertEqual(accept["payload"]["permission"], "control")
        self.assertEqual(
            accept["payload"]["expiresAt"], 1_000_000 + CONTROL_GRANT_TTL_MS
        )
        self.assertTrue(agent._granted_control)

    async def test_expired_control_grant_releases_input_and_notifies_viewer(self) -> None:
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                control_enabled=True,
            )
        )
        sink = FakeInputSink()
        controller = InputController(sink, frame_width=1280, frame_height=720)
        controller.set_source_size(1280, 720)
        controller.handle(
            {
                "data": {"code": "KeyA"},
                "event": "key.down",
                "sequence": 1,
                "sessionId": "session_0123456789abcdef",
                "timestamp": 999_000,
                "version": 1,
            },
            now=1.0,
        )
        sink.calls.clear()
        agent._granted_control = True
        agent._control_expires_at_ms = 999_999
        agent._input_controller = controller
        websocket = _FakeWebSocket()
        agent._websocket = websocket

        with patch("mirror_host_agent.__main__.time.time", return_value=1000.0):
            agent._on_control_message(
                _FakeControlChannel(),
                json.dumps(
                    {
                        "data": {"code": "KeyA"},
                        "event": "key.up",
                        "sequence": 2,
                        "sessionId": "session_0123456789abcdef",
                        "timestamp": 1_000_000,
                        "version": 1,
                    }
                ),
            )
        await asyncio.sleep(0)

        self.assertFalse(agent._granted_control)
        self.assertIsNone(agent._input_controller)
        self.assertEqual(sink.calls, [("key", "KeyA", "up")])
        policy = next(m for m in websocket.sent if m["type"] == "session.policy")
        self.assertEqual(
            policy["payload"],
            {
                "controlEnabled": True,
                "controlGranted": False,
                "locked": False,
            },
        )

    async def test_active_control_grant_cannot_be_extended_by_re_request(self) -> None:
        # A hostile viewer must not keep a grant alive past its TTL by
        # re-sending session.request on the same socket. The expiry stays anchored
        # to the original grant and the running controller is left untouched.
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                control_enabled=True,
            )
        )
        controller = InputController(FakeInputSink(), frame_width=1280, frame_height=720)
        original_expiry = 5_000_000
        agent._granted_control = True
        agent._control_expires_at_ms = original_expiry
        agent._input_controller = controller
        websocket = _FakeWebSocket()
        request = json.dumps(
            {
                "payload": {
                    "deviceId": "device_0123456789abcdef",
                    "permission": "control",
                },
                "sequence": 2,
                "sessionId": "session_0123456789abcdef",
                "type": "session.request",
                "version": 1,
            }
        )

        # 1_000_000 ms is well before the 5_000_000 ms expiry: grant is active.
        with patch("mirror_host_agent.__main__.time.time", return_value=1000.0):
            await agent._handle_message(websocket, request)

        self.assertEqual(agent._control_expires_at_ms, original_expiry)
        self.assertIs(agent._input_controller, controller)
        self.assertTrue(agent._granted_control)
        accept = next(m for m in websocket.sent if m["type"] == "session.accept")
        self.assertEqual(accept["payload"]["permission"], "control")
        self.assertEqual(accept["payload"]["expiresAt"], original_expiry)

    async def test_view_re_request_downgrades_active_control(self) -> None:
        # A view re-request is a legitimate downgrade and must still revoke.
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                control_enabled=True,
            )
        )
        agent._granted_control = True
        agent._control_expires_at_ms = 5_000_000
        agent._input_controller = InputController(
            FakeInputSink(), frame_width=1280, frame_height=720
        )
        websocket = _FakeWebSocket()
        request = json.dumps(
            {
                "payload": {
                    "deviceId": "device_0123456789abcdef",
                    "permission": "view",
                },
                "sequence": 2,
                "sessionId": "session_0123456789abcdef",
                "type": "session.request",
                "version": 1,
            }
        )

        with patch("mirror_host_agent.__main__.time.time", return_value=1000.0):
            await agent._handle_message(websocket, request)

        self.assertFalse(agent._granted_control)
        self.assertIsNone(agent._input_controller)
        self.assertIsNone(agent._control_expires_at_ms)
        accept = next(m for m in websocket.sent if m["type"] == "session.accept")
        self.assertEqual(accept["payload"]["permission"], "view")

    async def test_emergency_stop_releases_input_and_locks_control_until_restart(self) -> None:
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                control_enabled=True,
            )
        )
        sink = FakeInputSink()
        controller = InputController(sink, frame_width=1280, frame_height=720)
        controller.set_source_size(1280, 720)
        controller.handle(
            {
                "data": {"button": "left", "action": "down"},
                "event": "pointer.button",
                "sequence": 1,
                "sessionId": "session_0123456789abcdef",
                "timestamp": 1_000_000,
                "version": 1,
            },
            now=1.0,
        )
        sink.calls.clear()
        agent._granted_control = True
        agent._control_expires_at_ms = 2_000_000
        agent._input_controller = controller

        agent.emergency_stop()

        self.assertFalse(agent.control_enabled)
        self.assertFalse(agent._granted_control)
        self.assertEqual(sink.calls, [("button", "left", "up")])

        websocket = _FakeWebSocket()
        await agent._handle_message(
            websocket,
            json.dumps(
                {
                    "payload": {
                        "deviceId": "device_0123456789abcdef",
                        "permission": "control",
                    },
                    "sequence": 2,
                    "sessionId": "session_0123456789abcdef",
                    "type": "session.request",
                    "version": 1,
                }
            ),
        )
        accept = next(m for m in websocket.sent if m["type"] == "session.accept")
        self.assertEqual(accept["payload"]["permission"], "view")

    async def test_tray_disable_notifies_viewer_and_revokes_control(self) -> None:
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                control_enabled=True,
            )
        )
        websocket = _FakeWebSocket()
        agent._websocket = websocket
        agent._granted_control = True

        agent.set_control_enabled(False)
        await asyncio.sleep(0)

        policy = next(m for m in websocket.sent if m["type"] == "session.policy")
        self.assertEqual(
            policy["payload"],
            {
                "controlEnabled": False,
                "controlGranted": False,
                "locked": False,
            },
        )
        self.assertFalse(agent._granted_control)


class _FakeControlChannel:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def send(self, data: str) -> None:
        self.sent.append(json.loads(data))


class VideoProfileConfigureTests(unittest.IsolatedAsyncioTestCase):
    def _agent(self) -> M0Agent:
        return M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
            )
        )

    def _message(self, profile: str) -> str:
        return json.dumps(
            {
                "payload": {"videoProfile": profile},
                "sequence": 20,
                "sessionId": "session_0123456789abcdef",
                "type": "session.configure",
                "version": 1,
            }
        )

    async def test_replaces_track_and_acknowledges_applied_profile(self) -> None:
        agent = self._agent()
        sender = _FakeSender()
        agent._video_sender = sender
        agent._video_track = SyntheticVideoTrack()
        websocket = _FakeWebSocket()

        await agent._handle_message(websocket, self._message("low"))

        self.assertEqual(agent._video_profile.name, "low")
        self.assertEqual(len(sender.tracks), 1)
        self.assertEqual(sender.tracks[0].source_size, (960, 540))
        configured = next(m for m in websocket.sent if m["type"] == "session.configured")
        self.assertEqual(configured["payload"], {"videoProfile": "low"})

    async def test_accepts_high_profile(self) -> None:
        # Regression: the allowlist must track video.PROFILES, not a stale
        # {"low","balanced"} literal, or the viewer's High option is rejected.
        agent = self._agent()
        sender = _FakeSender()
        agent._video_sender = sender
        agent._video_track = SyntheticVideoTrack()
        websocket = _FakeWebSocket()

        await agent._handle_message(websocket, self._message("high"))

        self.assertEqual(agent._video_profile.name, "high")
        self.assertEqual((agent._video_profile.width, agent._video_profile.height), (1600, 1000))
        configured = next(m for m in websocket.sent if m["type"] == "session.configured")
        self.assertEqual(configured["payload"], {"videoProfile": "high"})
        self.assertFalse(any(m["type"] == "error" for m in websocket.sent))

    async def test_rejects_unknown_profile(self) -> None:
        agent = self._agent()
        agent._video_sender = _FakeSender()
        agent._video_track = SyntheticVideoTrack()
        websocket = _FakeWebSocket()

        await agent._handle_message(websocket, self._message("ultra"))

        error = next(m for m in websocket.sent if m["type"] == "error")
        self.assertEqual(error["payload"]["code"], "INVALID_VIDEO_PROFILE")

    async def test_rejects_profile_change_without_active_sender(self) -> None:
        agent = self._agent()
        websocket = _FakeWebSocket()

        await agent._handle_message(websocket, self._message("low"))

        error = next(m for m in websocket.sent if m["type"] == "error")
        self.assertEqual(
            error["payload"], {"code": "NO_ACTIVE_SESSION", "retryable": True}
        )


class ClipboardTests(unittest.TestCase):
    def _agent(self, clipboard_enabled: bool) -> M0Agent:
        return M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                clipboard_enabled=clipboard_enabled,
            )
        )

    def test_clipboard_message_shape(self) -> None:
        agent = self._agent(clipboard_enabled=True)
        with patch("mirror_host_agent.__main__.time.time", return_value=1000.0):
            message = agent._clipboard_message("hello")
        self.assertEqual(message["event"], "clipboard.text")
        self.assertEqual(message["data"], {"text": "hello"})
        self.assertEqual(message["sessionId"], "session_0123456789abcdef")
        self.assertEqual(message["timestamp"], 1_000_000)
        self.assertEqual(message["version"], 1)
        self.assertIsInstance(message["sequence"], int)

    def test_clipboard_monitor_is_noop_when_disabled(self) -> None:
        agent = self._agent(clipboard_enabled=False)
        agent._start_clipboard_monitor()
        self.assertIsNone(agent._clipboard_task)

    def test_clipboard_set_writes_host_clipboard_when_enabled(self) -> None:
        agent = self._agent(clipboard_enabled=True)
        with patch(
            "mirror_host_agent.windows_clipboard.write_clipboard_text",
            return_value=True,
        ) as writer:
            agent._handle_clipboard_set({"text": "회사에서 복사한 텍스트"})
        writer.assert_called_once_with("회사에서 복사한 텍스트")

    def test_clipboard_set_is_noop_when_disabled(self) -> None:
        agent = self._agent(clipboard_enabled=False)
        with patch(
            "mirror_host_agent.windows_clipboard.write_clipboard_text"
        ) as writer:
            agent._handle_clipboard_set({"text": "must-not-write"})
        writer.assert_not_called()

    def test_clipboard_set_ignores_empty_or_non_string(self) -> None:
        agent = self._agent(clipboard_enabled=True)
        with patch(
            "mirror_host_agent.windows_clipboard.write_clipboard_text"
        ) as writer:
            agent._handle_clipboard_set({"text": ""})
            agent._handle_clipboard_set({"text": 123})
            agent._handle_clipboard_set({})
        writer.assert_not_called()

    def test_clipboard_set_is_rate_limited(self) -> None:
        agent = self._agent(clipboard_enabled=True)
        with patch(
            "mirror_host_agent.windows_clipboard.write_clipboard_text",
            return_value=True,
        ) as writer, patch(
            "mirror_host_agent.__main__.time.monotonic",
            side_effect=[100.0, 100.05],
        ):
            agent._handle_clipboard_set({"text": "first"})
            agent._handle_clipboard_set({"text": "second-too-soon"})
        writer.assert_called_once_with("first")

    def test_clipboard_set_allowed_again_after_interval(self) -> None:
        agent = self._agent(clipboard_enabled=True)
        with patch(
            "mirror_host_agent.windows_clipboard.write_clipboard_text",
            return_value=True,
        ) as writer, patch(
            "mirror_host_agent.__main__.time.monotonic",
            side_effect=[100.0, 100.5],
        ):
            agent._handle_clipboard_set({"text": "first"})
            agent._handle_clipboard_set({"text": "second-ok"})
        self.assertEqual(writer.call_count, 2)


class SessionAdoptionTests(unittest.IsolatedAsyncioTestCase):
    """Option A (ADR-018): the always-on agent adopts the viewer's session."""

    def _agent(self) -> M0Agent:
        return M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_boot_0123456789",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
            )
        )

    @staticmethod
    def _envelope(message_type: str, session_id: str, payload: dict) -> str:
        return json.dumps(
            {
                "payload": payload,
                "sequence": 1,
                "sessionId": session_id,
                "type": message_type,
                "version": 1,
            }
        )

    async def test_adopts_viewer_session_on_request(self) -> None:
        agent = self._agent()
        websocket = _FakeWebSocket()
        # Viewer's session differs from the agent's bootstrap session.
        await agent._handle_message(
            websocket,
            self._envelope(
                "session.request",
                "session_viewer_9876543210",
                {"deviceId": "device_0123456789abcdef", "permission": "view"},
            ),
        )

        self.assertEqual(agent._session_id, "session_viewer_9876543210")
        accept = websocket.sent[-1]
        self.assertEqual(accept["type"], "session.accept")
        # The reply now carries the adopted session so the room/viewer agree.
        self.assertEqual(accept["sessionId"], "session_viewer_9876543210")

    async def test_rejects_stale_session_after_adoption(self) -> None:
        agent = self._agent()
        websocket = _FakeWebSocket()
        await agent._handle_message(
            websocket,
            self._envelope(
                "session.request",
                "session_viewer_9876543210",
                {"deviceId": "device_0123456789abcdef", "permission": "view"},
            ),
        )

        # A message tagged with the old bootstrap session is now foreign.
        with self.assertRaises(ValueError):
            await agent._handle_message(
                websocket,
                self._envelope(
                    "session.configure",
                    "session_boot_0123456789",
                    {"videoProfile": "low"},
                ),
            )

    async def test_error_frame_is_exempt_from_session_match(self) -> None:
        agent = self._agent()
        websocket = _FakeWebSocket()
        await agent._handle_message(
            websocket,
            self._envelope(
                "session.request",
                "session_viewer_9876543210",
                {"deviceId": "device_0123456789abcdef", "permission": "view"},
            ),
        )

        # Server 'error' frames carry the room's own sessionId; they must be
        # logged, not treated as a fatal mismatch.
        await agent._handle_message(
            websocket,
            self._envelope(
                "error", "session_boot_0123456789", {"code": "RATE_LIMITED"}
            ),
        )


class _FakeChannel:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def send(self, data: str) -> None:
        self.sent.append(json.loads(data))


class FileTransferHandlingTests(unittest.TestCase):
    """Agent-side file-v1 handling (offer -> accept -> chunks -> done)."""

    def _agent(self, tmp: str, *, enabled: bool = True) -> tuple[M0Agent, _FakeChannel]:
        agent = M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_0123456789abcdef",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
                files_enabled=enabled,
                files_dir=tmp,
            )
        )
        channel = _FakeChannel()
        agent._file_channel = channel  # type: ignore[assignment]
        return agent, channel

    @staticmethod
    def _offer(name: str, size: int, sha256: str) -> str:
        return json.dumps(
            {
                "data": {
                    "name": name,
                    "sha256": sha256,
                    "size": size,
                    "transferId": "transfer_0123456789",
                },
                "event": "file.offer",
                "sequence": 1,
                "sessionId": "session_0123456789abcdef",
                "timestamp": int(time.time() * 1000),
                "version": 1,
            }
        )

    @staticmethod
    def _complete() -> str:
        return json.dumps(
            {
                "data": {"transferId": "transfer_0123456789"},
                "event": "file.complete",
                "sequence": 2,
                "sessionId": "session_0123456789abcdef",
                "timestamp": int(time.time() * 1000),
                "version": 1,
            }
        )

    def test_happy_path_writes_and_reports_done(self) -> None:
        import hashlib
        import tempfile
        from pathlib import Path

        data = b"remote upload payload" * 500
        with tempfile.TemporaryDirectory() as tmp:
            agent, channel = self._agent(tmp)
            agent._on_file_message(self._offer("doc.txt", len(data), hashlib.sha256(data).hexdigest()))
            agent._on_file_message(data)
            agent._on_file_message(self._complete())

            events = [m["event"] for m in channel.sent]
            self.assertEqual(events, ["file.accept", "file.done"])
            saved = Path(tmp) / "Incoming" / "doc.txt"
            self.assertEqual(saved.read_bytes(), data)

    def test_offer_rejected_when_disabled(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            agent, channel = self._agent(tmp, enabled=False)
            agent._on_file_message(self._offer("doc.txt", 4, "a" * 64))
            self.assertEqual(channel.sent[-1]["event"], "file.error")
            self.assertEqual(channel.sent[-1]["data"]["code"], "FILES_DISABLED")

    def test_blocked_extension_reported(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            agent, channel = self._agent(tmp)
            agent._on_file_message(self._offer("evil.exe", 4, "a" * 64))
            self.assertEqual(channel.sent[-1]["data"]["code"], "BLOCKED_TYPE")

    def test_digest_mismatch_reports_error_and_writes_nothing(self) -> None:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            agent, channel = self._agent(tmp)
            agent._on_file_message(self._offer("doc.txt", 4, "a" * 64))
            agent._on_file_message(b"data")
            agent._on_file_message(self._complete())
            self.assertEqual(channel.sent[-1]["event"], "file.error")
            self.assertEqual(channel.sent[-1]["data"]["code"], "DIGEST_MISMATCH")
            self.assertFalse((Path(tmp) / "Incoming").exists() and any((Path(tmp) / "Incoming").iterdir()))

    def test_wrong_session_offer_ignored(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            agent, channel = self._agent(tmp)
            bad = json.loads(self._offer("doc.txt", 4, "a" * 64))
            bad["sessionId"] = "session_intruder_000000"
            agent._on_file_message(json.dumps(bad))
            self.assertEqual(channel.sent, [])


class RunForeverTests(unittest.IsolatedAsyncioTestCase):
    """Auto-reconnect loop: backoff, session reset, cancellation."""

    def _agent(self) -> M0Agent:
        return M0Agent(
            AgentConfig(
                device_id="device_0123456789abcdef",
                heartbeat_stop_after_seconds=None,
                session_id="session_boot_0123456789",
                ticket="not-used",
                ws_url="ws://127.0.0.1:8787/ws",
            )
        )

    async def test_retries_with_exponential_backoff_and_stops_on_cancel(self) -> None:
        agent = self._agent()
        attempts = 0

        async def failing_run() -> None:
            nonlocal attempts
            attempts += 1
            raise OSError("connection refused")

        delays: list[float] = []

        async def fake_sleep(delay: float) -> None:
            delays.append(delay)
            if len(delays) >= 4:
                raise asyncio.CancelledError

        with (
            patch.object(agent, "run", failing_run),
            patch("mirror_host_agent.__main__.asyncio.sleep", fake_sleep),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await agent.run_forever()

        self.assertEqual(attempts, 4)
        # 2 -> 4 -> 8 -> 16, capped later at 60.
        self.assertEqual(delays, [2.0, 4.0, 8.0, 16.0])

    async def test_delay_caps_at_maximum(self) -> None:
        agent = self._agent()

        async def failing_run() -> None:
            raise OSError("boom")

        delays: list[float] = []

        async def fake_sleep(delay: float) -> None:
            delays.append(delay)
            if len(delays) >= 8:
                raise asyncio.CancelledError

        with (
            patch.object(agent, "run", failing_run),
            patch("mirror_host_agent.__main__.asyncio.sleep", fake_sleep),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await agent.run_forever()

        self.assertEqual(max(delays), 60.0)
        self.assertEqual(delays[-2:], [60.0, 60.0])

    async def test_resets_adopted_session_before_each_attempt(self) -> None:
        agent = self._agent()
        seen_sessions: list[str] = []

        async def failing_run() -> None:
            seen_sessions.append(agent._session_id)
            # Simulate having adopted a viewer session during the connection.
            agent._session_id = "session_viewer_9876543210"
            raise OSError("dropped")

        async def fake_sleep(_delay: float) -> None:
            if len(seen_sessions) >= 2:
                raise asyncio.CancelledError

        with (
            patch.object(agent, "run", failing_run),
            patch("mirror_host_agent.__main__.asyncio.sleep", fake_sleep),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await agent.run_forever()

        # Every attempt starts from the bootstrap session, not the stale one.
        self.assertEqual(
            seen_sessions,
            ["session_boot_0123456789", "session_boot_0123456789"],
        )


if __name__ == "__main__":
    unittest.main()
