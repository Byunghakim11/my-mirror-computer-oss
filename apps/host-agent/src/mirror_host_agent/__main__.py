from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode

from aiortc import (
    RTCConfiguration,
    RTCDataChannel,
    RTCIceServer,
    RTCPeerConnection,
    RTCRtpSender,
    RTCSessionDescription,
)
from websockets.asyncio.client import connect

from .file_transfer import FileReceiver, FileTransferError
from .input_control import InputController, InputSink
from .outgoing import list_outgoing, resolve_outgoing_file
from .video import (
    DESKTOP_SOURCE,
    SYNTHETIC_SOURCE,
    SyntheticVideoTrack,  # re-exported for tests and existing import paths
    create_video_track,
    extract_primary_video_codec,
    get_profile,
)

LOGGER = logging.getLogger("mirror_host_agent")
PROTOCOL_VERSION = 1
MAX_SIGNALING_BYTES = 256 * 1024
MAX_CONTROL_BYTES = 4096
DEFAULT_VIDEO_PROFILE = "balanced"
CONTROL_WATCHDOG_INTERVAL_SECONDS = 1.0
CONTROL_GRANT_TTL_MS = 60 * 60 * 1000
CLIPBOARD_POLL_INTERVAL_SECONDS = 0.7
CONTROL_TIMESTAMP_SKEW_MS = 30_000
# Per-chunk cap on the file DataChannel — bounds memory and matches the viewer's
# send size. The whole-file cap is enforced by FileReceiver (ADR-014).
MAX_FILE_CHUNK_BYTES = 256 * 1024
DEFAULT_FILES_DIRNAME = "MirrorShare"
# Download (agent -> viewer) streaming: chunk size and the send-buffer high-water
# mark that pauses reading so a slow link cannot blow up memory.
FILE_DOWNLOAD_CHUNK_BYTES = 64 * 1024
FILE_DOWNLOAD_HIGH_WATER_BYTES = 8 * 1024 * 1024
# Auto-reconnect (always-on agent): capped exponential backoff. A connection
# that stayed up at least the stable window resets the backoff.
RECONNECT_INITIAL_DELAY_SECONDS = 2.0
RECONNECT_MAX_DELAY_SECONDS = 60.0
RECONNECT_STABLE_RESET_SECONDS = 60.0

__all__ = ["AgentConfig", "M0Agent", "SyntheticVideoTrack", "main", "run_agent"]


def configure_dpi_awareness() -> None:
    """Set Per-Monitor DPI Aware V2 so capture and coordinate mapping use
    physical pixels. No-op off Windows; best-effort on older Windows without the
    API."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == -4
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:  # noqa: BLE001 - never fatal
        LOGGER.warning("Could not set Per-Monitor DPI Aware V2")


@dataclass(frozen=True)
class AgentConfig:
    device_id: str
    heartbeat_stop_after_seconds: float | None
    session_id: str
    ticket: str
    ws_url: str
    video_source: str = SYNTHETIC_SOURCE
    video_profile: str = DEFAULT_VIDEO_PROFILE
    control_enabled: bool = False
    clipboard_enabled: bool = False
    files_enabled: bool = False
    files_dir: str = ""


class M0Agent:
    def __init__(self, config: AgentConfig):
        self._device_id = config.device_id
        self._heartbeat_stop_after_seconds = config.heartbeat_stop_after_seconds
        self._session_id = config.session_id
        # Original configured session id. The agent adopts the viewer's session
        # during a connection (option A); each reconnect starts back from this
        # bootstrap id until the next viewer joins.
        self._bootstrap_session_id = config.session_id
        self._ticket = config.ticket
        self._ws_url = config.ws_url
        self._video_source = config.video_source
        self._video_profile = get_profile(config.video_profile)
        self._control_enabled = config.control_enabled
        self._emergency_locked = False
        self._connected = False
        self._status_listener: Callable[[str], None] | None = None
        self._sequence = 0
        self._peer: RTCPeerConnection | None = None
        self._websocket: Any = None
        self._video_sender: RTCRtpSender | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        # Per-session control state; set on grant, cleared on teardown.
        self._granted_control = False
        self._control_expires_at_ms: int | None = None
        self._pending_input_sink: InputSink | None = None
        self._video_track: Any = None
        self._input_controller: InputController | None = None
        self._watchdog_task: asyncio.Task[None] | None = None
        # One-way clipboard share (home PC -> viewer), opt-in and text-only.
        self._clipboard_enabled = config.clipboard_enabled
        self._control_channel: RTCDataChannel | None = None
        self._clipboard_task: asyncio.Task[None] | None = None
        self._last_clipboard_text: str | None = None
        # Sandboxed file receive (ADR-014), opt-in and default off.
        self._files_enabled = config.files_enabled
        self._files_dir = Path(config.files_dir) if config.files_dir else None
        self._file_channel: RTCDataChannel | None = None
        self._file_receiver: FileReceiver | None = None
        self._file_transfer_id: str | None = None
        # Sandboxed download (agent -> viewer) from the Outgoing folder. At most
        # one download runs at a time; its id gates the streaming loop.
        self._download_transfer_id: str | None = None
        self._download_task: asyncio.Task[None] | None = None

    def _next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    @property
    def control_enabled(self) -> bool:
        return self._control_enabled

    def set_status_listener(self, listener: Callable[[str], None]) -> None:
        self._status_listener = listener
        self._notify_status("offline")

    def _notify_status(self, status: str) -> None:
        if self._status_listener is not None:
            self._status_listener("locked" if self._emergency_locked else status)

    def set_control_enabled(self, enabled: bool) -> None:
        if enabled and self._emergency_locked:
            return
        self._control_enabled = enabled
        if not enabled:
            self._revoke_control()
        if self._peer is not None:
            self._notify_status("controlling" if self._granted_control else "viewing")
        else:
            self._notify_status("online" if self._connected else "offline")
        self._queue_policy_update()

    def _queue_policy_update(self) -> None:
        if self._websocket is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            LOGGER.debug("Could not queue policy update without a running event loop")
            return
        loop.create_task(self._send_policy_update())

    async def _send_policy_update(self) -> None:
        websocket = self._websocket
        if websocket is None:
            return
        try:
            await websocket.send(
                json.dumps(
                    self._message(
                        "session.policy",
                        {
                            "controlEnabled": self._control_enabled,
                            "controlGranted": self._granted_control,
                            "locked": self._emergency_locked,
                        },
                    )
                )
            )
        except Exception as error:  # noqa: BLE001 - connection teardown races are benign
            LOGGER.debug("Could not send local policy update: %s", type(error).__name__)

    def emergency_stop(self) -> None:
        """Fail closed for the rest of this process lifetime.

        The local hotkey is intentionally one-way: control can only be enabled
        again by restarting the agent with its explicit environment opt-in.
        """
        self._control_enabled = False
        self._emergency_locked = True
        self._revoke_control()
        self._notify_status("locked")
        self._queue_policy_update()
        LOGGER.warning("Local emergency stop activated; remote control locked")

    def _message(self, message_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "payload": payload,
            "sequence": self._next_sequence(),
            "sessionId": self._session_id,
            "type": message_type,
            "version": PROTOCOL_VERSION,
        }

    async def run_forever(self) -> None:
        """Keep the agent online: run() and reconnect with capped backoff.

        Every kind of drop is retried — network blips, signaling Worker
        redeploys, and auth rejections too (a 401 can be transient while a
        rotated secret propagates; a genuinely dead device token just keeps
        retrying at the max interval until the operator re-mints it). The
        emergency lock persists across reconnects because it lives on this
        instance. Cancellation (Ctrl+C / task cancel) exits the loop.
        """
        delay = RECONNECT_INITIAL_DELAY_SECONDS
        while True:
            # Reconnects renegotiate from scratch; drop any viewer session
            # adopted during the previous connection (option A).
            self._session_id = self._bootstrap_session_id
            started_at = time.monotonic()
            try:
                await self.run()
                LOGGER.warning("Signaling connection closed; retrying in %.0fs", delay)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - reconnect on any drop
                LOGGER.warning(
                    "Signaling connection lost (%s); retrying in %.0fs",
                    type(error).__name__,
                    delay,
                )
            if time.monotonic() - started_at >= RECONNECT_STABLE_RESET_SECONDS:
                delay = RECONNECT_INITIAL_DELAY_SECONDS
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_DELAY_SECONDS)

    async def run(self) -> None:
        query = urlencode({"ticket": self._ticket})
        websocket_url = f"{self._ws_url}?{query}"
        async with connect(
            websocket_url,
            max_size=MAX_SIGNALING_BYTES,
            origin=None,
            ping_interval=10,
            ping_timeout=10,
        ) as websocket:
            self._websocket = websocket
            self._connected = True
            self._notify_status("online")
            LOGGER.info("M0 agent connected to local signaling")
            await websocket.send(
                json.dumps(
                    self._message(
                        "agent.online",
                        {
                            "agentId": "agent_0123456789abcdef0",
                            "deviceId": self._device_id,
                            "protocolVersion": PROTOCOL_VERSION,
                        },
                    )
                )
            )
            self._heartbeat_task = asyncio.create_task(self._send_heartbeats(websocket))

            try:
                async for raw_message in websocket:
                    await self._handle_message(websocket, raw_message)
            finally:
                if self._heartbeat_task:
                    self._heartbeat_task.cancel()
                await self._close_peer()
                self._connected = False
                self._websocket = None
                self._notify_status("offline")

    async def _send_heartbeats(self, websocket: Any) -> None:
        started_at = time.monotonic()
        while True:
            await asyncio.sleep(3)
            if (
                self._heartbeat_stop_after_seconds is not None
                and time.monotonic() - started_at
                >= self._heartbeat_stop_after_seconds
            ):
                LOGGER.info("M0 test mode stopped application heartbeats")
                return
            await websocket.send(
                json.dumps(self._message("agent.heartbeat", {}))
            )

    async def _handle_message(self, websocket: Any, raw_message: Any) -> None:
        if not isinstance(raw_message, str) or len(raw_message.encode()) > MAX_SIGNALING_BYTES:
            raise ValueError("Invalid signaling message transport")

        message = json.loads(raw_message)
        if not self._is_valid_envelope(message):
            raise ValueError("Invalid signaling envelope")

        message_type = message["type"]
        incoming_session = message["sessionId"]
        if message_type == "session.request":
            # Option A (ADR-018): the always-on agent connects with a bootstrap
            # sessionId (its device token) and adopts the viewer's session when a
            # viewer joins. The room is single-session, so there is exactly one
            # viewer to bind to.
            self._session_id = incoming_session
        elif message_type != "error" and incoming_session != self._session_id:
            # Server-originated 'error' frames carry the room's own sessionId and
            # are only logged, so they are exempt from the session match.
            raise ValueError("Signaling sessionId mismatch")

        if message_type == "session.request":
            requested = message["payload"].get("permission")
            requested_profile = message["payload"].get("videoProfile")
            if requested_profile in {"low", "balanced"}:
                self._video_profile = get_profile(requested_profile)
            # A viewer must not be able to extend or reset an active control
            # grant by re-requesting. The grant TTL is anchored to the original
            # grant; renewing requires a full reconnect. Echo the existing
            # expiry and leave the running controller untouched.
            if (
                requested == "control"
                and self._granted_control
                and self._control_grant_is_active()
            ):
                await websocket.send(
                    json.dumps(
                        self._message(
                            "session.accept",
                            {
                                "expiresAt": self._control_expires_at_ms,
                                "permission": "control",
                                "videoProfile": self._video_profile.name,
                            },
                        )
                    )
                )
                return
            # Control is granted only when the viewer asks for it AND the local
            # policy allows it AND injection is available (Windows). Otherwise the
            # session gracefully degrades to view-only.
            self._revoke_control()
            can_control = (
                requested == "control"
                and self._control_enabled
                and sys.platform == "win32"
            )
            if can_control:
                try:
                    from .windows_input import create_input_sink

                    self._pending_input_sink = create_input_sink()
                except Exception as error:  # noqa: BLE001 - fail closed
                    LOGGER.warning(
                        "Control backend preflight failed (%s); granting view only",
                        type(error).__name__,
                    )
                    can_control = False
            self._granted_control = can_control
            now_ms = int(time.time() * 1000)
            self._control_expires_at_ms = (
                now_ms + CONTROL_GRANT_TTL_MS if can_control else None
            )
            granted = "control" if can_control else "view"
            LOGGER.info(
                "session.request permission=%s -> granted=%s (local control %s)",
                requested,
                granted,
                "enabled" if self._control_enabled else "disabled",
            )
            await websocket.send(
                json.dumps(
                    self._message(
                        "session.accept",
                        {
                            "expiresAt": self._control_expires_at_ms
                            or now_ms + CONTROL_GRANT_TTL_MS,
                            "permission": granted,
                            "videoProfile": self._video_profile.name,
                        },
                    )
                )
            )
            return

        if message_type == "webrtc.offer":
            await self._answer_offer(websocket, message["payload"]["sdp"])
            return

        if message_type == "session.configure":
            profile_name = message["payload"].get("videoProfile")
            if profile_name not in {"low", "balanced"}:
                await self._send_error(websocket, "INVALID_VIDEO_PROFILE", False)
                return
            if self._video_sender is None:
                await self._send_error(websocket, "NO_ACTIVE_SESSION", True)
                return
            self._apply_video_profile(profile_name)
            await websocket.send(
                json.dumps(
                    self._message(
                        "session.configured", {"videoProfile": self._video_profile.name}
                    )
                )
            )
            return

        if message_type == "session.close":
            self._revoke_control()
            await self._close_peer()
            return

        if message_type == "error":
            LOGGER.warning("Signaling rejected a message: %s", message["payload"]["code"])

    def _is_valid_envelope(self, message: Any) -> bool:
        # Structural validation only. The sessionId is checked in _handle_message,
        # which adopts the viewer's session on session.request (see option A).
        return (
            isinstance(message, dict)
            and set(message) == {"payload", "sequence", "sessionId", "type", "version"}
            and message.get("version") == PROTOCOL_VERSION
            and isinstance(message.get("sessionId"), str)
            and isinstance(message.get("payload"), dict)
            and isinstance(message.get("sequence"), int)
            and isinstance(message.get("type"), str)
        )

    def _turn_url(self) -> str | None:
        """Derive the signaling Worker's /turn URL from the ws URL. None for a
        local ws:// dev endpoint (host/STUN candidates suffice there)."""
        if not self._ws_url.startswith("wss://"):
            return None
        base = "https://" + self._ws_url[len("wss://") :]
        base = base.rsplit("/ws", 1)[0]
        return f"{base}/turn?{urlencode({'ticket': self._ticket})}"

    @staticmethod
    def _http_get_json(url: str) -> Any:
        import urllib.request

        with urllib.request.urlopen(url, timeout=10) as response:  # noqa: S310 - https only
            return json.loads(response.read().decode("utf-8"))

    async def _fetch_ice_servers(self) -> list[RTCIceServer]:
        servers = [RTCIceServer(urls="stun:stun.cloudflare.com:3478")]
        turn_url = self._turn_url()
        if turn_url is None:
            return servers
        try:
            payload = await asyncio.to_thread(self._http_get_json, turn_url)
        except Exception as error:  # noqa: BLE001 - TURN is best-effort; fall back to STUN
            LOGGER.warning(
                "TURN credential fetch failed (%s); using STUN only",
                type(error).__name__,
            )
            return servers
        entries = payload.get("iceServers", []) if isinstance(payload, dict) else []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            urls = entry.get("urls")
            if urls:
                servers.append(
                    RTCIceServer(
                        urls=urls,
                        username=entry.get("username"),
                        credential=entry.get("credential"),
                    )
                )
        return servers

    async def _answer_offer(self, websocket: Any, sdp: Any) -> None:
        if not isinstance(sdp, str) or not 1 <= len(sdp) <= 131_072:
            raise ValueError("Invalid SDP offer")

        await self._close_peer()
        # STUN + TURN (from /turn, matching the viewer) so ICE can cross NAT and,
        # on UDP-blocked/firewalled networks, relay over TCP/TLS 443 (M3-05).
        peer = RTCPeerConnection(
            configuration=RTCConfiguration(iceServers=await self._fetch_ice_servers())
        )
        self._peer = peer
        track = create_video_track(self._video_source, self._video_profile)
        self._video_track = track
        self._video_sender = peer.addTrack(track)

        if self._granted_control:
            self._start_control()

        @peer.on("datachannel")
        def on_datachannel(channel: RTCDataChannel) -> None:
            if channel.label == "file-v1":
                self._attach_file_channel(channel)
                return
            if channel.label != "control-v1":
                channel.close()
                return

            self._control_channel = channel
            self._start_clipboard_monitor()

            @channel.on("message")
            def on_message(raw_control: Any) -> None:
                self._on_control_message(channel, raw_control)

            @channel.on("close")
            def on_close() -> None:
                self._stop_clipboard_monitor()
                if self._control_channel is channel:
                    self._control_channel = None

        await peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        await self._wait_for_ice_gathering(peer)
        local_description = peer.localDescription
        if local_description is None:
            raise RuntimeError("Failed to create WebRTC answer")

        await websocket.send(
            json.dumps(
                self._message("webrtc.answer", {"sdp": local_description.sdp})
            )
        )
        codec = extract_primary_video_codec(local_description.sdp)
        LOGGER.info(
            "Negotiated video: source=%s profile=%s %dx%d@%dfps codec=%s",
            self._video_source,
            self._video_profile.name,
            self._video_profile.width,
            self._video_profile.height,
            self._video_profile.fps,
            codec or "unknown",
        )
        self._notify_status("controlling" if self._granted_control else "viewing")

    async def _send_error(
        self, websocket: Any, code: str, retryable: bool
    ) -> None:
        await websocket.send(
            json.dumps(self._message("error", {"code": code, "retryable": retryable}))
        )

    def _apply_video_profile(self, profile_name: str) -> None:
        sender = self._video_sender
        if sender is None:
            raise RuntimeError("No active video sender")
        new_profile = get_profile(profile_name)
        if new_profile.name == self._video_profile.name:
            return
        old_track = self._video_track
        new_track = create_video_track(self._video_source, new_profile)
        sender.replaceTrack(new_track)
        self._video_profile = new_profile
        self._video_track = new_track
        if self._input_controller is not None:
            self._input_controller.set_frame_size(new_profile.width, new_profile.height)
        if old_track is not None:
            old_track.stop()
        LOGGER.info(
            "Video profile changed: profile=%s %dx%d@%dfps",
            new_profile.name,
            new_profile.width,
            new_profile.height,
            new_profile.fps,
        )

    def _start_control(self) -> None:
        """Create the injection sink + controller for a granted control session.
        Falls back to view-only if injection is unavailable."""
        sink = self._pending_input_sink
        self._pending_input_sink = None
        if sink is None:
            LOGGER.warning("Control backend was not prepared; staying view-only")
            self._revoke_control()
            return
        self._input_controller = InputController(
            sink,
            frame_width=self._video_profile.width,
            frame_height=self._video_profile.height,
        )
        self._watchdog_task = asyncio.create_task(self._run_input_watchdog())
        LOGGER.info("Control granted: input injection active")
        self._notify_status("controlling")

    async def _run_input_watchdog(self) -> None:
        while True:
            await asyncio.sleep(CONTROL_WATCHDOG_INTERVAL_SECONDS)
            if not self._control_grant_is_active():
                self._revoke_control()
                self._queue_policy_update()
                LOGGER.info("Control grant expired; viewer downgraded to view-only")
                return
            controller = self._input_controller
            if controller is not None:
                controller.on_watchdog_tick(time.monotonic())

    def _on_control_message(self, channel: RTCDataChannel, raw_control: Any) -> None:
        if self._granted_control and not self._control_grant_is_active():
            self._revoke_control()
            self._queue_policy_update()
            LOGGER.info("Expired control input rejected; viewer notified")
        pong = self._create_pong(raw_control)
        if pong is not None:
            channel.send(json.dumps(pong))
            return
        controller = self._input_controller
        if not self._granted_control or controller is None:
            return
        message = self._parse_control(raw_control)
        if message is None:
            return
        source = getattr(self._video_track, "source_size", None)
        if source is not None:
            controller.set_source_size(source[0], source[1])
        controller.handle(message, now=time.monotonic())

    def _parse_control(self, raw_control: Any) -> dict[str, Any] | None:
        if not isinstance(raw_control, str) or len(raw_control.encode()) > MAX_CONTROL_BYTES:
            return None
        try:
            message = json.loads(raw_control)
        except json.JSONDecodeError:
            return None
        timestamp = message.get("timestamp") if isinstance(message, dict) else None
        now_ms = int(time.time() * 1000)
        if (
            not isinstance(message, dict)
            or set(message) != {"data", "event", "sequence", "sessionId", "timestamp", "version"}
            or type(message.get("version")) is not int
            or message.get("version") != PROTOCOL_VERSION
            or message.get("sessionId") != self._session_id
            or not isinstance(message.get("event"), str)
            or type(message.get("sequence")) is not int
            or type(timestamp) is not int
            or abs(timestamp - now_ms) > CONTROL_TIMESTAMP_SKEW_MS
            or not isinstance(message.get("data"), dict)
        ):
            return None
        return message

    def _attach_file_channel(self, channel: RTCDataChannel) -> None:
        self._file_channel = channel

        @channel.on("message")
        def on_message(raw: Any) -> None:
            self._on_file_message(raw)

        @channel.on("close")
        def on_close() -> None:
            if self._file_channel is channel:
                self._file_channel = None
            self._reset_file_transfer()
            self._cancel_download()

    def _file_message(self, event: str, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "data": data,
            "event": event,
            "sequence": self._next_sequence(),
            "sessionId": self._session_id,
            "timestamp": int(time.time() * 1000),
            "version": PROTOCOL_VERSION,
        }

    def _send_file(self, event: str, data: dict[str, Any]) -> None:
        channel = self._file_channel
        if channel is None:
            return
        try:
            channel.send(json.dumps(self._file_message(event, data)))
        except Exception as error:  # noqa: BLE001 - teardown races are benign
            LOGGER.debug("Could not send file message: %s", type(error).__name__)

    def _reset_file_transfer(self) -> None:
        if self._file_receiver is not None:
            self._file_receiver.abort()
        self._file_receiver = None
        self._file_transfer_id = None

    def _on_file_message(self, raw: Any) -> None:
        if isinstance(raw, (bytes, bytearray)):
            self._on_file_chunk(bytes(raw))
            return
        message = self._parse_file_message(raw)
        if message is None:
            return
        event = message["event"]
        data = message["data"]
        if event == "file.offer":
            self._on_file_offer(data)
        elif event == "file.complete":
            self._on_file_complete(data)
        elif event == "file.cancel":
            self._reset_file_transfer()
            self._cancel_download()
        elif event == "file.list-request":
            self._on_file_list_request()
        elif event == "file.download":
            self._on_file_download(data)

    def _on_file_offer(self, data: dict[str, Any]) -> None:
        transfer_id = data.get("transferId")
        if not self._files_enabled or self._files_dir is None:
            self._send_file("file.error", {"code": "FILES_DISABLED", "transferId": transfer_id})
            return
        if self._file_receiver is not None:
            self._send_file("file.error", {"code": "BUSY", "transferId": transfer_id})
            return
        receiver = FileReceiver(
            self._files_dir / "Incoming",
            mark_of_the_web=_apply_mark_of_the_web,
        )
        try:
            receiver.begin(data.get("name"), data.get("size"), data.get("sha256"))
        except FileTransferError as error:
            self._send_file("file.error", {"code": error.code, "transferId": transfer_id})
            return
        self._file_receiver = receiver
        self._file_transfer_id = transfer_id
        self._send_file("file.accept", {"transferId": transfer_id})

    def _on_file_chunk(self, chunk: bytes) -> None:
        receiver = self._file_receiver
        if receiver is None:
            return
        if len(chunk) > MAX_FILE_CHUNK_BYTES:
            self._fail_file_transfer("CHUNK_TOO_LARGE")
            return
        try:
            receiver.write_chunk(chunk)
        except FileTransferError as error:
            self._fail_file_transfer(error.code)

    def _on_file_complete(self, data: dict[str, Any]) -> None:
        receiver = self._file_receiver
        transfer_id = self._file_transfer_id
        if receiver is None or data.get("transferId") != transfer_id:
            return
        try:
            result = receiver.finish()
        except FileTransferError as error:
            self._fail_file_transfer(error.code)
            return
        LOGGER.info("Received file into Incoming (%d bytes)", result.size)
        self._send_file(
            "file.done", {"savedAs": result.path.name, "transferId": transfer_id}
        )
        self._file_receiver = None
        self._file_transfer_id = None

    def _fail_file_transfer(self, code: str) -> None:
        transfer_id = self._file_transfer_id
        self._reset_file_transfer()
        self._send_file("file.error", {"code": code, "transferId": transfer_id})

    def _outgoing_dir(self) -> Path | None:
        if not self._files_enabled or self._files_dir is None:
            return None
        return self._files_dir / "Outgoing"

    def _cancel_download(self) -> None:
        self._download_transfer_id = None  # cooperatively stops the stream loop
        task = self._download_task
        self._download_task = None
        if task is not None and not task.done():
            task.cancel()

    def _on_file_list_request(self) -> None:
        outgoing = self._outgoing_dir()
        if outgoing is None:
            self._send_file("file.list", {"files": []})
            return
        try:
            outgoing.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        self._send_file("file.list", {"files": list_outgoing(outgoing)})

    def _on_file_download(self, data: dict[str, Any]) -> None:
        transfer_id = data.get("transferId")
        outgoing = self._outgoing_dir()
        if outgoing is None:
            self._send_file(
                "file.error", {"code": "FILES_DISABLED", "transferId": transfer_id}
            )
            return
        if self._download_transfer_id is not None:
            self._send_file("file.error", {"code": "BUSY", "transferId": transfer_id})
            return
        path = resolve_outgoing_file(outgoing, data.get("name"))
        if path is None:
            self._send_file(
                "file.error", {"code": "NOT_FOUND", "transferId": transfer_id}
            )
            return
        self._download_transfer_id = transfer_id
        self._download_task = asyncio.ensure_future(
            self._run_download(path, transfer_id)
        )

    async def _run_download(self, path: Path, transfer_id: Any) -> None:
        """Stream one Outgoing file to the viewer as raw binary chunks, framed by
        a download-offer (size up front) and a download-complete (sha256 after).
        The hash is computed in the same single pass that streams the bytes."""
        channel = self._file_channel
        try:
            size = path.stat().st_size
        except OSError:
            self._send_file(
                "file.error", {"code": "NOT_FOUND", "transferId": transfer_id}
            )
            self._download_transfer_id = None
            return
        self._send_file(
            "file.download-offer",
            {"name": path.name, "size": size, "transferId": transfer_id},
        )
        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                while True:
                    if (
                        channel is None
                        or channel.readyState != "open"
                        or self._download_transfer_id != transfer_id
                    ):
                        return  # cancelled / channel gone
                    chunk = handle.read(FILE_DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    digest.update(chunk)
                    while channel.bufferedAmount > FILE_DOWNLOAD_HIGH_WATER_BYTES:
                        await asyncio.sleep(0.02)
                        if channel.readyState != "open":
                            return
                    channel.send(chunk)
                    await asyncio.sleep(0)
        except asyncio.CancelledError:
            raise
        except OSError:
            self._send_file(
                "file.error", {"code": "READ_FAILED", "transferId": transfer_id}
            )
            self._download_transfer_id = None
            return
        self._send_file(
            "file.download-complete",
            {"sha256": digest.hexdigest(), "transferId": transfer_id},
        )
        LOGGER.info("Sent file from Outgoing (%d bytes)", size)
        self._download_transfer_id = None

    def _parse_file_message(self, raw: Any) -> dict[str, Any] | None:
        if not isinstance(raw, str) or len(raw.encode()) > MAX_SIGNALING_BYTES:
            return None
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return None
        timestamp = message.get("timestamp") if isinstance(message, dict) else None
        now_ms = int(time.time() * 1000)
        if (
            not isinstance(message, dict)
            or set(message) != {"data", "event", "sequence", "sessionId", "timestamp", "version"}
            or type(message.get("version")) is not int
            or message.get("version") != PROTOCOL_VERSION
            or message.get("sessionId") != self._session_id
            or message.get("event")
            not in {
                "file.offer",
                "file.complete",
                "file.cancel",
                "file.list-request",
                "file.download",
            }
            or type(message.get("sequence")) is not int
            or type(timestamp) is not int
            or abs(timestamp - now_ms) > CONTROL_TIMESTAMP_SKEW_MS
            or not isinstance(message.get("data"), dict)
        ):
            return None
        return message

    def _control_grant_is_active(self) -> bool:
        return (
            self._granted_control
            and self._control_expires_at_ms is not None
            and int(time.time() * 1000) < self._control_expires_at_ms
        )

    def _stop_control_runtime(self) -> None:
        if self._watchdog_task is not None:
            self._watchdog_task.cancel()
            self._watchdog_task = None
        if self._input_controller is not None:
            self._input_controller.release_all()
            self._input_controller = None

    def _revoke_control(self) -> None:
        self._stop_control_runtime()
        self._pending_input_sink = None
        self._granted_control = False
        self._control_expires_at_ms = None

    def _start_clipboard_monitor(self) -> None:
        if (
            not self._clipboard_enabled
            or sys.platform != "win32"
            or self._clipboard_task is not None
        ):
            return
        self._clipboard_task = asyncio.create_task(self._run_clipboard_monitor())

    def _stop_clipboard_monitor(self) -> None:
        if self._clipboard_task is not None:
            self._clipboard_task.cancel()
            self._clipboard_task = None
        self._last_clipboard_text = None

    async def _run_clipboard_monitor(self) -> None:
        """Poll the host clipboard and forward NEW text to the viewer over the
        control channel. Text-only, size-capped, and never written back."""
        from .windows_clipboard import read_clipboard_text

        # Seed with the current contents so only copies made after the viewer
        # connected are forwarded.
        self._last_clipboard_text = read_clipboard_text()
        while True:
            await asyncio.sleep(CLIPBOARD_POLL_INTERVAL_SECONDS)
            channel = self._control_channel
            if channel is None:
                return
            text = read_clipboard_text()
            if text is None or text == self._last_clipboard_text:
                continue
            self._last_clipboard_text = text
            try:
                channel.send(json.dumps(self._clipboard_message(text)))
            except Exception as error:  # noqa: BLE001 - benign channel races
                LOGGER.debug(
                    "Could not send clipboard update: %s", type(error).__name__
                )

    def _clipboard_message(self, text: str) -> dict[str, Any]:
        return {
            "data": {"text": text},
            "event": "clipboard.text",
            "sequence": self._next_sequence(),
            "sessionId": self._session_id,
            "timestamp": int(time.time() * 1000),
            "version": PROTOCOL_VERSION,
        }

    def _create_pong(self, raw_control: Any) -> dict[str, Any] | None:
        if not isinstance(raw_control, str) or len(raw_control.encode()) > 4096:
            return None
        try:
            message = json.loads(raw_control)
        except json.JSONDecodeError:
            return None

        if (
            not isinstance(message, dict)
            or set(message) != {"data", "event", "sequence", "sessionId", "timestamp", "version"}
            or message.get("event") != "session.ping"
            or message.get("sessionId") != self._session_id
            or message.get("version") != PROTOCOL_VERSION
            or message.get("data") != {}
            or not isinstance(message.get("sequence"), int)
            or not isinstance(message.get("timestamp"), int)
        ):
            return None

        return {
            "data": {},
            "event": "session.pong",
            "sequence": message["sequence"],
            "sessionId": self._session_id,
            "timestamp": message["timestamp"],
            "version": PROTOCOL_VERSION,
        }

    async def _wait_for_ice_gathering(self, peer: RTCPeerConnection) -> None:
        if peer.iceGatheringState == "complete":
            return

        completed = asyncio.Event()

        @peer.on("icegatheringstatechange")
        def on_ice_gathering_state_change() -> None:
            if peer.iceGatheringState == "complete":
                completed.set()

        await asyncio.wait_for(completed.wait(), timeout=10)

    async def _close_peer(self) -> None:
        # Release any held input first so a teardown never leaves stuck keys.
        self._stop_control_runtime()
        self._stop_clipboard_monitor()
        # Discard any half-written incoming file (temp .part is cleaned up).
        self._reset_file_transfer()
        self._file_channel = None
        self._control_channel = None
        self._video_track = None
        self._video_sender = None
        if self._peer is not None:
            await self._peer.close()
            self._peer = None
        if self._connected:
            self._notify_status("online")


def _apply_mark_of_the_web(path: Path) -> None:
    """Tag a received file as internet-zone (ZoneId=3) via the NTFS
    Zone.Identifier stream so SmartScreen/Office treat it as downloaded. Windows
    + NTFS only; best-effort (the caller ignores OSError)."""
    if sys.platform != "win32":
        return
    marker = path.with_name(path.name + ":Zone.Identifier")
    with open(marker, "w", encoding="ascii") as stream:
        stream.write("[ZoneTransfer]\nZoneId=3\n")


def load_required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value


async def run_agent() -> None:
    heartbeat_stop_value = os.environ.get("MIRROR_HEARTBEAT_STOP_AFTER_SECONDS")
    video_source = os.environ.get("MIRROR_VIDEO_SOURCE", SYNTHETIC_SOURCE)
    if video_source.strip().lower() == DESKTOP_SOURCE:
        # DPI awareness must be set once, before any capture starts.
        configure_dpi_awareness()
    agent = M0Agent(
        AgentConfig(
            device_id=load_required_environment("MIRROR_DEVICE_ID"),
            heartbeat_stop_after_seconds=(
                float(heartbeat_stop_value) if heartbeat_stop_value else None
            ),
            session_id=load_required_environment("MIRROR_SESSION_ID"),
            # Production uses the HMAC device token (MIRROR_DEVICE_TOKEN); local
            # dev uses the dev ticket. Both are presented as ?ticket= on /ws and
            # the Worker verifies by host (dev-ticket locally, device token in
            # production).
            ticket=(
                os.environ.get("MIRROR_DEVICE_TOKEN")
                or load_required_environment("MIRROR_DEV_TICKET")
            ),
            ws_url=os.environ.get("MIRROR_WS_URL", "ws://127.0.0.1:8787/ws"),
            video_source=video_source,
            video_profile=os.environ.get("MIRROR_VIDEO_PROFILE", DEFAULT_VIDEO_PROFILE),
            control_enabled=os.environ.get("MIRROR_CONTROL_ENABLED", "0") == "1",
            clipboard_enabled=os.environ.get("MIRROR_CLIPBOARD_ENABLED", "0") == "1",
            files_enabled=os.environ.get("MIRROR_FILES_ENABLED", "0") == "1",
            files_dir=os.environ.get(
                "MIRROR_FILES_DIR",
                str(Path.home() / DEFAULT_FILES_DIRNAME),
            ),
        )
    )
    emergency_stop_monitor: Any = None
    tray_controller: Any = None
    if sys.platform == "win32":
        from .windows_emergency_stop import WindowsEmergencyStopMonitor
        from .tray import TrayController

        loop = asyncio.get_running_loop()
        emergency_stop_monitor = WindowsEmergencyStopMonitor(
            lambda: loop.call_soon_threadsafe(agent.emergency_stop)
        )
        try:
            emergency_stop_monitor.start()
            tray_controller = TrayController(
                control_enabled=agent.control_enabled,
                on_control_change=lambda enabled: loop.call_soon_threadsafe(
                    agent.set_control_enabled, enabled
                ),
                on_emergency_lock=lambda: loop.call_soon_threadsafe(
                    agent.emergency_stop
                ),
            )
            agent.set_status_listener(tray_controller.set_status)
            tray_controller.start()
            LOGGER.warning("Tray ready; Ctrl+Alt+F12 locks remote control")
        except Exception as error:  # noqa: BLE001 - fail closed if local safety UI fails
            LOGGER.error("Local safety UI unavailable; control disabled: %s", error)
            if emergency_stop_monitor is not None:
                emergency_stop_monitor.stop()
            agent.emergency_stop()
            emergency_stop_monitor = None
            tray_controller = None
    try:
        await agent.run_forever()
    finally:
        if emergency_stop_monitor is not None:
            emergency_stop_monitor.stop()
        if tray_controller is not None:
            tray_controller.stop()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        asyncio.run(run_agent())
    except KeyboardInterrupt:
        LOGGER.info("M0 agent stopped")


if __name__ == "__main__":
    main()
