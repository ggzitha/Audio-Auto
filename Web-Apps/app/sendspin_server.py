"""
Sendspin Protocol Server — Audio-Auto implementation  v5.0
══════════════════════════════════════════════════════════
Spec: https://github.com/Sendspin/spec

Key design decisions vs v4.0:
 • Message fields at top level (spec compliant, not nested under 'payload')
 • Monotonic clock (time.monotonic_ns // 1000 µs) for all timestamps
 • PCM codec — raw signed 16-bit LE, 44100 Hz stereo
     → zero decode overhead on ESP32 (direct I2S write)
     → ffmpeg converts any source file to raw PCM
 • Per-client send-ahead based on required_lead_time_ms + min_buffer_ms
 • server_received ≠ server_transmitted (captures real processing gap)
 • Binary audio frame: byte[0]=4, bytes[1-8]=server_ts int64 BE, bytes[9..]=PCM
"""

import asyncio
import json
import struct
import time
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

# ─── Audio constants ──────────────────────────────────────────────────────────
PCM_SAMPLE_RATE  = 44100
PCM_CHANNELS     = 2
PCM_BIT_DEPTH    = 16
PCM_BYTES_FRAME  = (PCM_BIT_DEPTH // 8) * PCM_CHANNELS   # 4 bytes per stereo frame
PCM_BYTES_SEC    = PCM_SAMPLE_RATE * PCM_BYTES_FRAME       # 176 400 bytes/s
PCM_CHUNK_SIZE   = 1008     # bytes per audio payload chunk (~5.7 ms)
                             # divisible by 4 (stereo 16-bit frame), fits under WS 1KB limit

# Frame header: type byte (4) + int64 BE timestamp = 9 bytes
FRAME_HEADER_SIZE = 9

# Server identity
SERVER_ID   = "audio-auto-sendspin"
SERVER_NAME = "Audio-Auto"

# Default send-ahead when client hasn't reported its timing requirements
DEFAULT_SEND_AHEAD_MS = 400


def monotonic_us() -> int:
    """Server monotonic clock in microseconds — used for ALL Sendspin timestamps."""
    return time.monotonic_ns() // 1000


def pack_audio_frame(server_ts_us: int, pcm_bytes: bytes) -> bytes:
    """Build a Sendspin Type 4 binary audio frame."""
    header = struct.pack(">Bq", 4, server_ts_us)   # type=4, int64 big-endian
    return header + pcm_bytes


# ─── Per-client state ─────────────────────────────────────────────────────────
class SendspinClient:
    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        # Identity (populated from client/hello)
        self.client_id:  str  = "unknown"
        self.name:       str  = "unknown"
        self.active_roles: list[str] = []
        # Timing requirements (populated from client/state)
        self.static_delay_ms:       int = 0
        self.required_lead_time_ms: int = DEFAULT_SEND_AHEAD_MS
        self.min_buffer_ms:         int = DEFAULT_SEND_AHEAD_MS
        # Buffer tracking
        self.buffer_capacity: int = 0    # bytes, advertised in client/hello
        self.bytes_in_flight: int = 0    # bytes sent but not yet played (approx)
        # Connection state
        self.connection_state: str = "handshaking"
        # Clock sync tracking (populated from client/time exchanges)
        self.last_rtt_us:   float = 0.0
        self.sync_count:    int   = 0
        # Stream readiness gate: audio task only sends binary frames AFTER the
        # client has sent client/state (i.e., handshake is complete and the
        # ESP32 has set up its stream buffer).  Prevents flooding a freshly
        # reconnected client with frames before it is ready to receive them —
        # which was the root cause of the disconnect storm on reconnect.
        self.stream_ready:  bool  = False

    @property
    def send_ahead_ms(self) -> int:
        """Effective send-ahead: max of lead time and min buffer, plus static delay."""
        return max(self.required_lead_time_ms, self.min_buffer_ms) + self.static_delay_ms

    def is_player(self) -> bool:
        return "player@v1" in self.active_roles


# ─── Sendspin server ──────────────────────────────────────────────────────────
class SendspinServer:
    def __init__(self) -> None:
        self._clients:    dict[str, SendspinClient] = {}
        self._audio_task: Optional[asyncio.Task]    = None
        self.is_playing:  bool = False

    # ── Client management ────────────────────────────────────────────────────

    def _global_send_ahead_ms(self) -> int:
        """Largest send-ahead across all connected player clients."""
        players = [c for c in self._clients.values() if c.is_player()]
        if not players:
            return DEFAULT_SEND_AHEAD_MS
        return max(c.send_ahead_ms for c in players)

    async def _remove_dead(self, dead_ids: list[str]) -> None:
        for cid in dead_ids:
            self._clients.pop(cid, None)

    # ── WebSocket connection handler ─────────────────────────────────────────

    async def handle_connection(self, websocket: WebSocket) -> None:
        await websocket.accept()
        client = SendspinClient(websocket)

        try:
            # ── Step 1: Expect client/hello ──────────────────────────────────
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=15.0)
            msg = json.loads(raw)
            if msg.get("type") != "client/hello":
                await websocket.close(code=1008, reason="expected client/hello")
                return

            client.client_id = msg.get("client_id", "unknown")
            client.name      = msg.get("name", client.client_id)

            # Determine roles
            supported = msg.get("supported_roles", [])
            active: list[str] = []
            if "player@v1" in supported:
                active.append("player@v1")
                ps = msg.get("player@v1_support", {})
                cap = ps.get("buffer_capacity", 0)
                if isinstance(cap, (int, float)) and cap > 0:
                    client.buffer_capacity = int(cap)
            if "controller@v1" in supported:
                active.append("controller@v1")
            client.active_roles = active
            client.connection_state = "connected"

            self._clients[client.client_id] = client
            print(f"[Sendspin] Client connected: {client.name!r} roles={active} "
                  f"buf={client.buffer_capacity // 1024}KB")

            # ── Step 2: Send server/hello ────────────────────────────────────
            await websocket.send_text(json.dumps({
                "type":             "server/hello",
                "server_id":        SERVER_ID,
                "name":             SERVER_NAME,
                "version":          1,
                "active_roles":     active,
                "connection_reason":"discovery",
            }))

            # ── Step 3: If we are already streaming, catch the client up ─────
            if self.is_playing and client.is_player():
                await self._send_stream_start_to(client)

            # ── Main message loop ────────────────────────────────────────────
            while True:
                data = await websocket.receive()
                # Starlette returns {"type":"websocket.disconnect"} as a dict
                # before raising WebSocketDisconnect; break here so we don't
                # call receive() again on a dead socket (→ assertion error).
                if data.get("type") == "websocket.disconnect":
                    break
                if "text" in data:
                    await self._handle_text(client, data["text"])
                # Binary from client → ignore (clients don't send binary in player role)


        except (WebSocketDisconnect, asyncio.TimeoutError, asyncio.CancelledError):
            pass
        except Exception as exc:
            print(f"[Sendspin] Client {client.client_id!r} error: {exc}")
        finally:
            self._clients.pop(client.client_id, None)
            print(f"[Sendspin] Client disconnected: {client.name!r}")

    # ── Text message dispatch ─────────────────────────────────────────────────

    async def _handle_text(self, client: SendspinClient, text: str) -> None:
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            return

        msg_type = msg.get("type", "")

        if msg_type == "client/time":
            await self._handle_client_time(client, msg)

        elif msg_type == "client/state":
            await self._handle_client_state(client, msg)

        elif msg_type == "client/command":
            # Controller commands — could be forwarded to main.py in the future
            pass

        elif msg_type == "client/goodbye":
            raise WebSocketDisconnect()

    async def _handle_client_time(self, client: SendspinClient, msg: dict) -> None:
        """
        NTP-style clock sync.  Capture server_received immediately on arrival,
        server_transmitted just before sending — so they differ by real processing time.
        Also records RTT for the web dashboard sync chart.
        """
        server_received = monotonic_us()           # captured as early as possible
        T1 = msg.get("client_transmitted", 0)      # client's local µs timestamp

        # Any processing between receive and transmit captures real jitter
        server_transmitted = monotonic_us()

        await client.ws.send_text(json.dumps({
            "type":                 "server/time",
            "client_transmitted":    T1,            # echo back exactly
            "server_received":       server_received,
            "server_transmitted":    server_transmitted,
        }))

        # Record server-side processing gap as a proxy for RTT
        # (real RTT = client computes (T4-T1)-(T3-T2), but we only have server side here)
        processing_gap_us = server_transmitted - server_received
        client.last_rtt_us  = processing_gap_us
        client.sync_count  += 1

    async def _handle_client_state(self, client: SendspinClient, msg: dict) -> None:
        """Parse client timing requirements and update per-client state."""
        client.connection_state = msg.get("state", "synchronized")
        p = msg.get("player", {})
        if isinstance(p, dict):
            client.static_delay_ms       = p.get("static_delay_ms",       0)
            client.required_lead_time_ms = p.get("required_lead_time_ms", DEFAULT_SEND_AHEAD_MS)
            client.min_buffer_ms         = p.get("min_buffer_ms",         DEFAULT_SEND_AHEAD_MS)
        # Handshake complete: allow the audio task to send binary frames
        client.stream_ready = True
        print(f"[Sendspin] '{client.name}' state: "
              f"lead={client.required_lead_time_ms}ms "
              f"min_buf={client.min_buffer_ms}ms static_delay={client.static_delay_ms}ms "
              f"→ send_ahead={client.send_ahead_ms}ms")

        # If we're already playing and this is a late-joining client, catch it up
        if self.is_playing and client.is_player():
            await self._send_stream_start_to(client)

    # ── Stream lifecycle broadcast helpers ───────────────────────────────────

    async def _send_stream_start_to(self, client: SendspinClient) -> None:
        """Send stream/start for PCM to one client."""
        if not client.is_player():
            return
        await client.ws.send_text(json.dumps({
            "type":   "stream/start",
            "player": {
                "codec":       "pcm",
                "sample_rate": PCM_SAMPLE_RATE,
                "channels":    PCM_CHANNELS,
                "bit_depth":   PCM_BIT_DEPTH,
            },
        }))

    async def _broadcast_text(self, msg: dict) -> None:
        text = json.dumps(msg)
        dead: list[str] = []
        for cid, c in list(self._clients.items()):
            try:
                await c.ws.send_text(text)
            except Exception:
                dead.append(cid)
        await self._remove_dead(dead)

    async def _broadcast_stream_start(self) -> None:
        msg = json.dumps({
            "type":   "stream/start",
            "player": {
                "codec":       "pcm",
                "sample_rate": PCM_SAMPLE_RATE,
                "channels":    PCM_CHANNELS,
                "bit_depth":   PCM_BIT_DEPTH,
            },
        })
        dead: list[str] = []
        for cid, c in list(self._clients.items()):
            if not c.is_player():
                continue
            try:
                await c.ws.send_text(msg)
                c.bytes_in_flight = 0
            except Exception:
                dead.append(cid)
        await self._remove_dead(dead)

    # ── Audio streaming task ──────────────────────────────────────────────────

    async def _stream_audio_task(self, file_path: str, start_sec: float) -> None:
        """
        Stream raw PCM from ffmpeg to all connected player clients.

        Each chunk is prepended with a 9-byte header:
            byte[0]   = 4  (Sendspin Type 4 binary audio frame)
            byte[1-8] = server monotonic timestamp in µs (int64 big-endian)

        The server schedules chunks send_ahead_ms into the future so that clients
        can buffer audio before the play time arrives.
        """
        import subprocess

        cmd = [
            "ffmpeg",
            "-ss",  str(start_sec),
            "-i",   file_path,
            "-vn",                        # strip video/cover art
            "-map_metadata", "-1",         # strip ID3/metadata
            "-ar",  str(PCM_SAMPLE_RATE),
            "-ac",  str(PCM_CHANNELS),
            "-f",   "s16le",               # signed 16-bit little-endian PCM
            "-acodec", "pcm_s16le",
            "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        # ── CRITICAL: pre-read the first chunk BEFORE stamping any timestamps ────
        # ffmpeg takes 100–500 ms to open file, decode headers, and fill the pipe.
        # If we stamp timestamps before this read, the first chunk arrives at the
        # client with a play-time already in the past → immediate underrun.
        # Fix: block here until ffmpeg produces the first chunk, THEN stamp.
        first_chunk = proc.stdout.read(PCM_CHUNK_SIZE)
        if not first_chunk:
            proc.kill(); proc.wait()
            return
        remainder = len(first_chunk) % PCM_BYTES_FRAME
        if remainder:
            first_chunk += b'\x00' * (PCM_BYTES_FRAME - remainder)

        # Send-ahead: stamps how far ahead each chunk's play time is
        send_ahead_us: int = self._global_send_ahead_ms() * 1000

        # Time per chunk in µs (exact, based on byte rate)
        time_per_chunk_us: int = PCM_CHUNK_SIZE * 1_000_000 // PCM_BYTES_SEC

        # Timestamp of the first chunk's play time — NOW safe (ffmpeg is ready)
        current_ts_us: int = monotonic_us() + send_ahead_us

        print(f"[Sendspin] Streaming started: send_ahead={send_ahead_us // 1000}ms "
              f"chunk={PCM_CHUNK_SIZE}B ({time_per_chunk_us}µs)")

        async def _send_frame(ts_us: int, chunk: bytes) -> None:
            """Broadcast one audio frame to all READY player clients.

            Guards:
              • stream_ready=False → skip (handshake not complete yet)
              • asyncio.wait_for timeout=0.2s → slow/dead clients are
                cleanly removed. Keeping this short (0.2 s) limits the
                'debt' that accumulates while waiting: at most
                0.2s / 5.714ms ≈ 35 backlogged chunks (vs 175 at 1.0s).
            """
            frame = pack_audio_frame(ts_us, chunk)
            dead: list[str] = []
            for cid, c in list(self._clients.items()):
                if not c.is_player():
                    continue
                if not c.stream_ready:          # wait for handshake before flooding
                    continue
                try:
                    await asyncio.wait_for(
                        c.ws.send_bytes(frame),
                        timeout=0.2,            # drop stalled clients quickly
                    )
                except Exception:
                    dead.append(cid)
            await self._remove_dead(dead)

        async def _throttle(ts_us: int) -> None:
            """Sleep until (ts_us - send_ahead_us) so we send at real-time + lead."""
            target = ts_us - send_ahead_us
            delta  = target - monotonic_us()
            if delta > 0:
                await asyncio.sleep(delta / 1_000_000)
            else:
                await asyncio.sleep(0)  # yield to event loop

        try:
            # Send the first chunk (already read above)
            await _send_frame(current_ts_us, first_chunk)
            current_ts_us += time_per_chunk_us
            await _throttle(current_ts_us)

            while self.is_playing:
                chunk = proc.stdout.read(PCM_CHUNK_SIZE)
                if not chunk:
                    break

                remainder = len(chunk) % PCM_BYTES_FRAME
                if remainder:
                    chunk += b'\x00' * (PCM_BYTES_FRAME - remainder)

                # ── Slip compensation ─────────────────────────────────────────
                # If asyncio was delayed (slow WiFi ACK, OS scheduler jitter),
                # several chunk deadlines may have already passed.  Without
                # compensation, _throttle() returns immediately for each one
                # and we burst-send N chunks in a row → ESP32 stream buffer
                # overflows → dropped chunks → I2S underrun cascade.
                #
                # Fix: detect lateness; discard ffmpeg data to skip forward.
                # The ESP32 gets a brief silence (≤ skip_n × 5.7 ms) rather
                # than a burst that blows the buffer.
                now = monotonic_us()
                slip_us = now - (current_ts_us - send_ahead_us)  # >0 = behind
                if slip_us > time_per_chunk_us:                   # ≥ 1 chunk late
                    skip_n = min(int(slip_us // time_per_chunk_us) - 1, 16)
                    skipped = 0
                    for _ in range(skip_n):
                        if not self.is_playing:
                            break
                        discard = proc.stdout.read(PCM_CHUNK_SIZE)
                        if not discard:
                            break
                        current_ts_us += time_per_chunk_us
                        skipped += 1
                    if skipped:
                        print(f"[Sendspin] Slip +{skipped * time_per_chunk_us // 1000}ms "
                              f"(slip={slip_us // 1000}ms) — skipped {skipped} chunks")
                # ── End slip compensation ─────────────────────────────────────

                await _send_frame(current_ts_us, chunk)
                current_ts_us += time_per_chunk_us
                await _throttle(current_ts_us)

        except asyncio.CancelledError:
            pass
        finally:
            try:
                proc.kill()
                proc.wait()
            except Exception:
                pass
            # Natural song end: is_playing is still True (stop_playback() wasn't called).
            # Fix the inverted condition — broadcast stream/end and reset state.
            if self.is_playing:
                self.is_playing = False
                self._audio_task = None
                # Reset each client's stream_ready so reconnecting clients
                # go through the full handshake before the next stream.
                for c in self._clients.values():
                    c.stream_ready = False
                try:
                    await self._broadcast_text({
                        "type":  "stream/end",
                        "roles": ["player"],
                    })
                    await self._broadcast_text({
                        "type":           "group/update",
                        "playback_state": "stopped",
                        "group_id":       "group-audio-auto",
                        "group_name":     "All Speakers",
                    })
                except Exception:
                    pass
                print("[Sendspin] Stream finished naturally.")

    # ── Public API (called by main.py) ────────────────────────────────────────

    async def start_playback(self, file_path: str, start_sec: float,
                             bitrate_kbps: int = 128) -> None:
        """Start streaming PCM audio to all player clients.

        `bitrate_kbps` is kept for API compatibility but unused (we use raw PCM).
        """
        # Cancel any existing stream
        if self._audio_task and not self._audio_task.done():
            self._audio_task.cancel()
            try:
                await self._audio_task
            except (asyncio.CancelledError, Exception):
                pass

        self.is_playing = True

        # Reset in-flight counters and announce stream start
        await self._broadcast_stream_start()

        # Small pause — let stream/start arrive before the first audio frame
        await asyncio.sleep(0.05)

        loop = asyncio.get_running_loop()
        self._audio_task = loop.create_task(
            self._stream_audio_task(file_path, start_sec)
        )

        await self._broadcast_text({
            "type":           "group/update",
            "playback_state": "playing",
            "group_id":       "group-audio-auto",
            "group_name":     "All Speakers",
        })

    async def stop_playback(self) -> None:
        """Stop audio streaming and notify all clients."""
        self.is_playing = False

        if self._audio_task and not self._audio_task.done():
            self._audio_task.cancel()
            try:
                await self._audio_task
            except (asyncio.CancelledError, Exception):
                pass
        self._audio_task = None

        for c in self._clients.values():
            c.bytes_in_flight = 0
            c.stream_ready = False   # require re-handshake before next stream

        await self._broadcast_text({"type": "stream/end", "roles": ["player"]})
        await self._broadcast_text({
            "type":           "group/update",
            "playback_state": "stopped",
            "group_id":       "group-audio-auto",
            "group_name":     "All Speakers",
        })


    async def seek_playback(self, file_path: str, start_sec: float,
                            bitrate_kbps: int = 128) -> None:
        """Seek to a new position in the current stream."""
        if self._audio_task and not self._audio_task.done():
            self._audio_task.cancel()
            try:
                await self._audio_task
            except (asyncio.CancelledError, Exception):
                pass

        # stream/clear signals clients to discard buffered audio and re-sync
        await self._broadcast_text({"type": "stream/clear", "roles": ["player"]})

        for c in self._clients.values():
            c.bytes_in_flight = 0

        self.is_playing = True

        loop = asyncio.get_running_loop()
        self._audio_task = loop.create_task(
            self._stream_audio_task(file_path, start_sec)
        )

    def get_client_status(self) -> list[dict]:
        """Return status of all connected Sendspin clients (used by main.py)."""
        result = []
        for cid, c in self._clients.items():
            result.append({
                "id":                 cid,
                "name":              c.name,
                "roles":             c.active_roles,
                "state":             c.connection_state,
                "delay_ms":          c.static_delay_ms,
                "send_ahead_ms":     c.send_ahead_ms,
                "sync_count":        c.sync_count,
                "last_rtt_us":       round(c.last_rtt_us, 1),
                "buffer_capacity_kb": round(c.buffer_capacity / 1024, 1) if c.buffer_capacity else 0,
                "bytes_in_flight_kb": round(c.bytes_in_flight / 1024, 1),
            })
        return result


# Singleton used by main.py
sendspin_manager = SendspinServer()
