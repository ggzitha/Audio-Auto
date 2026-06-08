"""
Sendspin Protocol Server — Audio-Auto implementation  v6.0
══════════════════════════════════════════════════════════
Refactored to use the official `aiosendspin` library for spec compliance.
Includes: hot-join with stream re-init, real timing/sync data, codec management.
"""

import asyncio
import time
from typing import Optional

from aiosendspin.server import SendspinServer
from aiosendspin.server.push_stream import PushStream, AudioFormat
from aiosendspin.server.group import SendspinGroup
from .mp3_encoder import patch_aiosendspin_for_mp3, CODEC_ENCODER_MAP

# Apply monkey patch for all codecs (MP3, FLAC, OPUS)
patch_aiosendspin_for_mp3()


class SendspinManager:
    def __init__(self):
        self.server: Optional[SendspinServer] = None
        self.stream: Optional[PushStream] = None
        self.is_playing: bool = False
        self._audio_task: Optional[asyncio.Task] = None
        self.global_codec: str = "pcm"
        self.global_bitrate: int = 128
        self.global_sample_rate: int = 44100
        # Track per-client timing data for the dashboard
        self._client_timing: dict[str, dict] = {}

    async def init_server(self):
        """Called by main.py during startup to initialize the SendspinServer."""
        loop = asyncio.get_running_loop()
        self.server = SendspinServer(loop, "audio-auto-sendspin", "Audio-Auto")
        # Start server on default port 8927. Clients should connect to ws://host:8927/sendspin
        await self.server.start_server(port=8927, discover_clients=False)
        print("[Sendspin] aiosendspin Server initialized on port 8927")

    async def start_playback(self, file_path: str, start_sec: float, bitrate_kbps: int = 128):
        """Start streaming PCM audio to all connected players."""
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

        loop = asyncio.get_running_loop()
        group = SendspinGroup(self.server, *clients)
        self.stream = PushStream(loop=loop, clock=self.server.clock, group=group)
        self.is_playing = True
        self._audio_task = loop.create_task(self._stream_audio_task(file_path, start_sec))

    async def _stream_audio_task(self, file_path: str, start_sec: float):
        def log_debug(msg):
            with open("audio_files/error.log", "a") as f:
                f.write(msg + "\n")
                
        log_debug(f"Starting stream for {file_path} at {start_sec}")
        cmd = [
            "ffmpeg",
            "-ss", str(start_sec),
            "-i", file_path,
            "-vn", "-map_metadata", "-1",
            "-ar", "44100", "-ac", "2",
            "-f", "s16le", "-acodec", "pcm_s16le",
            "pipe:1"
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        
        async def read_stderr():
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                log_debug(f"[FFmpeg stderr] {line.decode().strip()}")
                print(f"[FFmpeg stderr] {line.decode().strip()}")
                
        loop = asyncio.get_running_loop()
        loop.create_task(read_stderr())
        
        fmt = AudioFormat(
            sample_rate=44100,
            channels=2,
            bit_depth=16
        )

        try:
            # Force the preferred format on all clients initially
            for client in self.server.connected_clients:
                player = client.role("player@v1")
                if player:
                    try:
                        player.set_preferred_format(fmt, codec=self.global_codec)
                    except Exception as e:
                        print(f"Failed to set codec {self.global_codec} on {client.client_id}: {e}")
            
            async def _hot_join_task():
                """Monitor for new clients and add them to the active stream group.
                   Also collects timing data from all connected clients."""
                while self.is_playing:
                    if self.stream and self.stream.group:
                        current_group_clients = set(self.stream.group.clients)
                        for c in self.server.connected_clients:
                            if c not in current_group_clients:
                                # New client! Set codec preference and add to group
                                p = c.role("player@v1")
                                if p:
                                    try:
                                        p.set_preferred_format(fmt, codec=self.global_codec)
                                    except Exception:
                                        pass
                                self.stream.group.add_client(c)
                                log_debug(f"Hot joined new client: {c.client_id}")
                    
                    # Collect timing data from all connected clients
                    self._collect_timing_data()
                    
                    await asyncio.sleep(1)
            
            hot_join_task = loop.create_task(_hot_join_task())

            while self.is_playing:
                chunk = await proc.stdout.read(1008) # ~5.7ms of PCM
                if not chunk:
                    break
                # pad if needed to maintain frame alignment
                rem = len(chunk) % 4
                if rem:
                    chunk += b'\x00' * (4 - rem)
                
                self.stream.prepare_audio(chunk, fmt)
                await self.stream.commit_audio()
                await self.stream.sleep_to_limit_buffer(max_buffer_us=5_000_000)
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
            timing = {
                "last_rtt_us": 0,
                "sync_count": 0,
                "sync_offset_us": 0.0,
            }
            
            # Try to extract clock/sync data from the client's internal state
            try:
                # aiosendspin stores clock sync info on the client object
                clock_state = getattr(client, '_clock_state', None)
                if clock_state is None:
                    clock_state = getattr(client, 'clock_state', None)
                
                if clock_state is not None:
                    timing["last_rtt_us"] = int(getattr(clock_state, 'last_rtt_us', 0) or 0)
                    timing["sync_count"] = int(getattr(clock_state, 'sync_count', 0) or 0)
                    timing["sync_offset_us"] = float(getattr(clock_state, 'offset_us', 0) or 0)
                
                # Alternative: check _time_sync or time_sync attribute
                time_sync = getattr(client, '_time_sync', None)
                if time_sync is None:
                    time_sync = getattr(client, 'time_sync', None)
                
                if time_sync is not None:
                    rtt = getattr(time_sync, 'last_rtt_us', None) or getattr(time_sync, 'rtt_us', None)
                    if rtt is not None:
                        timing["last_rtt_us"] = int(rtt)
                    
                    count = getattr(time_sync, 'sync_count', None) or getattr(time_sync, 'count', None)
                    if count is not None:
                        timing["sync_count"] = int(count)
                    
                    offset = getattr(time_sync, 'offset_us', None) or getattr(time_sync, 'offset', None)
                    if offset is not None:
                        timing["sync_offset_us"] = float(offset)
                
                # Another path: client.info may have timing
                info = getattr(client, 'info', None)
                if info is not None:
                    rtt = getattr(info, 'last_rtt_us', None)
                    if rtt is not None and rtt > 0:
                        timing["last_rtt_us"] = int(rtt)
                        
            except Exception as e:
                print(f"[Sendspin] Error collecting timing for {client_id}: {e}")
            
            self._client_timing[client_id] = timing

    async def stop_playback(self):
        self.is_playing = False
        if self._audio_task and not self._audio_task.done():
            self._audio_task.cancel()
            try:
                await self._audio_task
            except Exception:
                pass
        if self.stream:
            self.stream.stop()

    async def seek_playback(self, file_path: str, start_sec: float, bitrate_kbps: int = 128):
        await self.start_playback(file_path, start_sec, bitrate_kbps)

    def get_client_status(self) -> list[dict]:
        """Return status of all connected Sendspin clients with real timing data."""
        if not self.server:
            return []
        
        res = []
        for client in self.server.connected_clients:
            client_id = client.client_id
            client_name = getattr(client, 'name', None)
            if client_name is None:
                # Try to get name from client info
                info = getattr(client, 'info', None)
                if info is not None:
                    client_name = getattr(info, 'name', client_id)
                else:
                    client_name = client_id
            
            # Get timing data we've been collecting
            timing = self._client_timing.get(client_id, {})
            
            # Get roles
            roles = []
            try:
                if hasattr(client, 'roles'):
                    roles = [str(r) for r in client.roles]
                elif hasattr(client, '_roles'):
                    roles = [str(r) for r in client._roles]
            except Exception:
                pass
            
            # Get buffer info from player role
            buffer_cap_kb = 0
            bytes_in_flight_kb = 0
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

            res.append({
                "id": client_id,
                "name": client_name,
                "roles": roles,
                "state": "connected",
                "delay_ms": 0,
                "send_ahead_ms": 0,
                "sync_count": timing.get("sync_count", 0),
                "last_rtt_us": timing.get("last_rtt_us", 0),
                "sync_offset_us": timing.get("sync_offset_us", 0.0),
                "buffer_capacity_kb": buffer_cap_kb,
                "bytes_in_flight_kb": bytes_in_flight_kb,
            })
        return res

# Singleton used by main.py
sendspin_manager = SendspinManager()
