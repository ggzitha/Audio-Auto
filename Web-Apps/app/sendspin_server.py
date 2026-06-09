"""
Sendspin Protocol Server — Audio-Auto implementation  v8.1
═══════════════════════════════════════════════════════════════════════════
v8.1 — Fixed Time Sync per Sendspin SPEC:
  • Server now uses monotonic clock in microseconds (not Unix epoch)
  • All timestamps in server/time use microseconds relative to monotonic clock
  • This ensures proper clock sync with ESP32 and Web clients
  • FIX v8.0: Removed MQTT audio commands (play/stop/seek)
  • ALL audio via Sendspin WebSocket streaming
"""

import asyncio
import time
from typing import Optional, Dict

from aiosendspin.server import SendspinServer
from aiosendspin.server.push_stream import PushStream, AudioFormat
from aiosendspin.server.group import SendspinGroup
from .mp3_encoder import patch_aiosendspin_for_mp3, CODEC_ENCODER_MAP

# Apply monkey patch for MP3, FLAC, OPUS codecs
patch_aiosendspin_for_mp3()


# ═══════════════════════════════════════════════════════════════════════════════
# FIX: Patch aiosendspin's server clock to use monotonic time in microseconds
# Per Sendspin SPEC: "For synchronization, all timing is relative to the server's
# monotonic clock. These timestamps have microsecond precision and are not
# necessarily based on epoch time."
# ═══════════════════════════════════════════════════════════════════════════════
def _patch_aiosendspin_time_sync():
    """Patch aiosendspin to use monotonic clock for time sync."""
    try:
        import aiosendspin
        import time as time_module
        
        # Patch the server's time sync handler to use monotonic clock
        from aiosendspin.server.handlers.time_sync import TimeSyncHandler
        from aiosendspin.server.handlers.base import WebSocketHandler
        
        original_handle_time = TimeSyncHandler.handle_client_time
        
        def patched_handle_client_time(self, client_id: str, client_transmitted_us: int):
            # Get server's monotonic clock timestamp
            loop = asyncio.get_running_loop()
            server_received_us = int(loop.time() * 1_000_000)
            server_transmitted_us = int(loop.time() * 1_000_000)
            
            # Build response per SPEC:
            # server/time contains: client_transmitted, server_received, server_transmitted
            # All in microseconds relative to server's monotonic clock
            response = {
                "type": "server/time",
                "payload": {
                    "client_transmitted": client_transmitted_us,
                    "server_received": server_received_us,
                    "server_transmitted": server_transmitted_us,
                }
            }
            
            if hasattr(self, '_send_to_client'):
                self._send_to_client(client_id, response)
            return True
        
        # Only patch if the method signature allows
        TimeSyncHandler.handle_client_time = patched_handle_client_time
        print("[Sendspin] Patched aiosendspin time sync to use monotonic clock")
        
    except ImportError as e:
        print(f"[Sendspin] Could not patch time sync: {e}")
    except Exception as e:
        print(f"[Sendspin] Time sync patch failed: {e}")

_patch_aiosendspin_time_sync()


class ClientTimingData:
    """Tracks timing data for each connected client."""
    def __init__(self, client_id: str):
        self.client_id = client_id
        self.last_t1_us: int = 0
        self.last_t2_us: int = 0
        self.last_t3_us: int = 0
        self.last_t4_us: int = 0
        self.rtt_us: int = 0
        self.sync_count: int = 0
        self.sync_offset_us: float = 0.0
        self.last_sync_time: float = 0.0


class SendspinManager:
    def __init__(self):
        self.server: Optional[SendspinServer] = None
        self.stream: Optional[PushStream] = None
        self.is_playing: bool = False
        self._audio_task: Optional[asyncio.Task] = None
        self.global_codec: str = "pcm"
        self.global_bitrate: int = 128
        self.global_sample_rate: int = 44100
        self._client_timing: Dict[str, ClientTimingData] = {}
        self._stream_start_unix: float = 0.0
        self._stream_position_offset: float = 0.0
        self._current_file: str = ""
        self._current_position: float = 0.0

    async def init_server(self):
        """Called by main.py during startup to initialize the SendspinServer."""
        loop = asyncio.get_running_loop()
        self.server = SendspinServer(loop, "audio-auto-sendspin", "Audio-Auto")
        await self.server.start_server(
            port=8927, 
            discover_clients=False,
        )
        print("[Sendspin] aiosendspin Server initialized on port 8927")

    async def start_playback(self, file_path: str, start_sec: float, bitrate_kbps: int = 128):
        """Start streaming audio to all connected Sendspin clients (ESP32 + Web)."""
        if self._audio_task and not self._audio_task.done():
            self._audio_task.cancel()
            try:
                await self._audio_task
            except Exception:
                pass
        
        if self.stream:
            self.stream.stop()

        if not self.server:
            return

        clients = self.server.connected_clients
        if not clients:
            print("[Sendspin] No connected clients. Skipping PushStream start.")
            return

        self._current_file = file_path
        self._current_position = start_sec
        self._stream_start_unix = time.time()
        self._stream_position_offset = start_sec

        effective_codec = self.global_codec
        valid_codecs = ["pcm", "flac", "opus"]
        if effective_codec not in valid_codecs:
            effective_codec = "pcm"
        
        print(f"[Sendspin] Starting playback with codec={effective_codec} (bitrate={bitrate_kbps}kbps)")
        
        loop = asyncio.get_running_loop()
        group = SendspinGroup(self.server, *clients)
        self.stream = PushStream(loop=loop, clock=self.server.clock, group=group)
        self.is_playing = True
        self._audio_task = loop.create_task(self._stream_audio_task(file_path, start_sec, effective_codec))

    async def _stream_audio_task(self, file_path: str, start_sec: float, effective_codec: str):
        """Internal streaming task - decodes audio and sends via Sendspin."""
        def log_debug(msg):
            with open("audio_files/error.log", "a") as f:
                f.write(msg + "\n")
                
        log_debug(f"Starting stream for {file_path} at {start_sec} with codec={effective_codec}")
        print(f"[Sendspin] Streaming with codec={effective_codec}")
        
        from .mp3_encoder import CODEC_ENCODER_MAP, _get_av
        
        if effective_codec == "pcm":
            encoder_cls = None
        else:
            encoder_cls = CODEC_ENCODER_MAP.get(effective_codec)
        
        sample_rate = 48000 if effective_codec == "opus" else 44100
        
        # Build FFmpeg command to decode to raw PCM
        cmd = [
            "ffmpeg",
            "-ss", str(start_sec),
            "-i", file_path,
            "-vn", "-map_metadata", "-1",
            "-ar", str(sample_rate), "-ac", "2",
            "-f", "s16le", "-acodec", "pcm_s16le",
            "pipe:1"
        ]
        
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        
        async def read_stderr():
            while True:
                try:
                    line = await proc.stderr.readline()
                    if not line:
                        break
                    log_debug(f"[FFmpeg stderr] {line.decode().strip()}")
                    print(f"[FFmpeg stderr] {line.decode().strip()}")
                except Exception:
                    break
                
        loop = asyncio.get_running_loop()
        loop.create_task(read_stderr())
        
        pcm_chunk_duration_us = 25_000
        pcm_chunk_samples = (sample_rate * pcm_chunk_duration_us // 1_000_000)
        pcm_chunk_samples = (pcm_chunk_samples + 1) // 2 * 2
        pcm_chunk_size = pcm_chunk_samples * 2 * 2
        pcm_chunk_size = (pcm_chunk_size + 3) // 4 * 4
        
        encoder = None
        if encoder_cls:
            print(f"[Sendspin] Initializing {effective_codec.upper()} encoder...")
            encoder = encoder_cls(
                sample_rate=sample_rate,
                bit_depth=16,
                channels=2,
                chunk_duration_us=pcm_chunk_duration_us
            )
        
        fmt = AudioFormat(
            sample_rate=sample_rate,
            channels=2,
            bit_depth=16
        )
        
        # Track hot join task reference for proper cleanup
        hot_join_task = None

        try:
            # Set preferred format on all clients
            for client in self.server.connected_clients:
                player = client.role("player@v1")
                if player:
                    try:
                        player.set_preferred_format(fmt, codec=effective_codec)
                    except Exception as e:
                        print(f"Failed to set codec {effective_codec} on {client.client_id}: {e}")
            
            # Hot-join monitoring task
            async def _hot_join_task():
                # FIX: Check both self.is_playing AND stream existence
                while self.is_playing and self.stream is not None:
                    try:
                        if self.stream and self.stream.group:
                            current_group_clients = set(self.stream.group.clients)
                            for c in self.server.connected_clients:
                                if c not in current_group_clients:
                                    p = c.role("player@v1")
                                    if p:
                                        try:
                                            p.set_preferred_format(fmt, codec=effective_codec)
                                        except Exception:
                                            pass
                                    self.stream.group.add_client(c)
                                    
                                    seek_to = 0.0
                                    if self._stream_start_unix > 0:
                                        elapsed = time.time() - self._stream_start_unix
                                        seek_to = self._stream_position_offset + elapsed
                                        log_debug(f"Hot joined new client: {c.client_id} (seek to {seek_to:.1f}s)")
                                    
                                    try:
                                        p.send_message_type("stream/start", {
                                            "player": {
                                                "codec": effective_codec,
                                                "sample_rate": sample_rate,
                                                "channels": 2,
                                                "bit_depth": 16,
                                                "position": seek_to,
                                            }
                                        })
                                    except Exception as e:
                                        log_debug(f"Failed to send stream/start to {c.client_id}: {e}")
                        
                        self._collect_timing_data()
                        
                    except Exception as e:
                        log_debug(f"Hot join task error: {e}")
                    
                    await asyncio.sleep(1)
                log_debug("[Sendspin] Hot join task ended")
            
            hot_join_task = loop.create_task(_hot_join_task())
            
            start_time_us = loop.time() * 1_000_000
            frame_idx = 0
            pcm_buffer = bytearray()
            
            while self.is_playing:
                try:
                    chunk = await asyncio.wait_for(proc.stdout.read(pcm_chunk_size), timeout=5.0)
                except asyncio.TimeoutError:
                    log_debug("[Sendspin] ffmpeg timeout - stream ended")
                    break
                    
                if not chunk:
                    log_debug(f"[Sendspin] FFmpeg ended, {len(pcm_buffer)} bytes remaining in buffer")
                    break
                
                pcm_buffer.extend(chunk)
                
                while len(pcm_buffer) >= pcm_chunk_size:
                    frame_data = bytes(pcm_buffer[:pcm_chunk_size])
                    del pcm_buffer[:pcm_chunk_size]
                    
                    timestamp_us = start_time_us + (frame_idx * pcm_chunk_duration_us)
                    duration_us = pcm_chunk_duration_us
                    
                    if encoder:
                        try:
                            frames = encoder.process(frame_data, timestamp_us, duration_us)
                            for encoded_data, delta_us in frames:
                                self.stream.prepare_audio(encoded_data, fmt)
                                await self.stream.commit_audio()
                        except Exception as e:
                            log_debug(f"[Sendspin] Encoder error: {e}")
                            continue
                    else:
                        rem = len(frame_data) % 4
                        if rem:
                            frame_data = frame_data + b'\x00' * (4 - rem)
                        self.stream.prepare_audio(frame_data, fmt)
                        await self.stream.commit_audio()
                    
                    frame_idx += 1
                    await asyncio.sleep(pcm_chunk_duration_us / 1_000_000)
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log_debug(f"[Sendspin] Streaming error: {e}")
            import traceback
            log_debug(traceback.format_exc())
            print(f"[Sendspin] Streaming error: {e}")
        finally:
            log_debug("Stream stopped cleanly")
            self.is_playing = False
            if 'hot_join_task' in locals():
                hot_join_task.cancel()
            if self.stream:
                self.stream.stop()
            try:
                proc.kill()
            except Exception:
                pass

    def _collect_timing_data(self):
        """Extract real RTT, sync offset, and sync count from connected clients."""
        if not self.server:
            return
        
        for client in self.server.connected_clients:
            client_id = client.client_id
            
            if client_id not in self._client_timing:
                self._client_timing[client_id] = ClientTimingData(client_id)
            
            timing = self._client_timing[client_id]
            
            try:
                # FIX: More efficient attribute lookup with early exit
                # Try most likely attributes first for ESP32 clients
                clock_state = getattr(client, '_clock_state', None)
                if clock_state is None:
                    clock_state = getattr(client, 'clock_state', None)
                if clock_state is None:
                    clock_state = getattr(client, '_sync', None)
                
                if clock_state is not None:
                    # RTT: try last_rtt_us first (more precise), fallback to rtt_us
                    rtt = getattr(clock_state, 'last_rtt_us', None)
                    if rtt is None:
                        rtt = getattr(clock_state, 'rtt_us', None)
                    if rtt is not None and rtt > 0:
                        timing.rtt_us = int(rtt)
                    
                    # Sync count
                    count = getattr(clock_state, 'sync_count', None)
                    if count is None:
                        count = getattr(clock_state, 'count', None)
                    if count is not None:
                        timing.sync_count = int(count)
                    
                    # Offset
                    offset = getattr(clock_state, 'offset_us', None)
                    if offset is None:
                        offset = getattr(clock_state, 'offset', None)
                    if offset is not None:
                        timing.sync_offset_us = float(offset)
                    
                    # Last sync time
                    last_time = getattr(clock_state, 'last_sync_time', None)
                    if last_time is None:
                        last_time = getattr(clock_state, 'timestamp', None)
                    if last_time is not None:
                        timing.last_sync_time = float(last_time)
                        
            except Exception as e:
                pass

    def handle_client_time_message(self, client_id: str, t1: int, t2: int, t3: int, t4: int):
        """Called by main.py when processing client/time messages to track RTT."""
        if client_id not in self._client_timing:
            self._client_timing[client_id] = ClientTimingData(client_id)
        
        timing = self._client_timing[client_id]
        timing.last_t1_us = t1
        timing.last_t2_us = t2
        timing.last_t3_us = t3
        timing.last_t4_us = t4
        
        timing.rtt_us = (t4 - t1) - (t3 - t2)
        if timing.rtt_us < 0:
            timing.rtt_us = -timing.rtt_us
        
        timing.sync_offset_us = ((t2 - t1) + (t3 - t4)) / 2
        timing.sync_count += 1
        timing.last_sync_time = time.time()

    async def stop_playback(self):
        """Stop streaming and send stream/end to all clients."""
        self.is_playing = False
        
        # Send stream/end to all connected clients
        if self.server:
            for client in self.server.connected_clients:
                try:
                    player = client.role("player@v1")
                    if player:
                        player.send_message_type("stream/end", {})
                except Exception:
                    pass
        
        if self._audio_task and not self._audio_task.done():
            self._audio_task.cancel()
            try:
                await self._audio_task
            except Exception:
                pass
        if self.stream:
            self.stream.stop()

    async def seek_playback(self, file_path: str, start_sec: float, bitrate_kbps: int = 128):
        """Restart stream from new position."""
        self._current_position = start_sec
        self._stream_position_offset = start_sec
        await self.start_playback(file_path, start_sec, bitrate_kbps)

    def get_client_status(self) -> list[dict]:
        """Return status of all connected Sendspin clients with real timing data."""
        if not self.server:
            return []
        
        res = []
        for client in self.server.connected_clients:
            client_id = client.client_id
            client_name = getattr(client, 'name', None) or getattr(client, 'client_id', client_id)
            
            timing = self._client_timing.get(client_id)
            
            roles = []
            try:
                if hasattr(client, 'roles'):
                    roles = [str(r) for r in client.roles]
                elif hasattr(client, '_roles'):
                    roles = [str(r) for r in client._roles]
            except Exception:
                pass
            
            buffer_cap_kb = 0
            try:
                player = client.role("player@v1")
                if player:
                    support = getattr(player, '_client', None)
                    if support:
                        player_info = getattr(support, 'info', None)
                        if player_info:
                            player_support = getattr(player_info, 'player_support', None)
                            if player_support:
                                buf_cap = getattr(player_support, 'buffer_capacity', 0)
                                if buf_cap:
                                    buffer_cap_kb = int(buf_cap / 1024)
            except Exception:
                pass

            audio_state = "idle"
            stream_group = getattr(self.stream, 'group', None) if self.stream else None
            if self.is_playing and stream_group and hasattr(stream_group, 'clients') and client in stream_group.clients:
                audio_state = "playing"
            
            res.append({
                "id": client_id,
                "name": client_name,
                "roles": roles,
                "state": audio_state,
                "delay_ms": timing.rtt_us / 2000 if timing else 0,
                "send_ahead_ms": 200,
                "sync_count": timing.sync_count if timing else 0,
                "last_rtt_us": timing.rtt_us if timing else 0,
                "sync_offset_us": timing.sync_offset_us if timing else 0.0,
                "buffer_capacity_kb": buffer_cap_kb,
                "bytes_in_flight_kb": 0,
            })
        return res


# Singleton used by main.py
sendspin_manager = SendspinManager()