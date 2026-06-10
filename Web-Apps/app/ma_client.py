"""
ma_client.py — Music Assistant WebSocket + HTTP API client.

Architecture:
 - WebSocket connection to MA:  real-time events pushed to this app's browser WS clients
 - HTTP RPC (POST /api):        fire-and-forget commands (play, pause, volume, seek …)

MA HTTP RPC format:
    POST http://MA_HOST/api
    Authorization: Bearer TOKEN
    Content-Type: application/json
    {"command": "players/cmd/play_pause", "args": {"player_id": "..."}}

MA WebSocket protocol:
    ws://MA_HOST/ws
    Server sends: {"type": "auth_required"}
    Client sends: {"message_id": 1, "command": "auth", "args": {"token": "Bearer TOKEN"}}
    Server sends: {"message_id": 1, "success": true}
    Server sends events: {"type": "player_updated", "data": {...player obj...}}
                         {"type": "queue_updated",  "data": {...queue obj...}}
                         {"type": "queue_time_updated", "data": {...}}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Callable, Optional

import httpx
import websockets
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

logger = logging.getLogger("ma_client")

MA_URL: str   = os.environ.get("MA_URL", "http://192.168.88.8:8095")
MA_TOKEN: str = os.environ.get("MA_TOKEN", "")
MA_GROUP_PLAYER: str = os.environ.get("MA_GROUP_PLAYER", "ESP32-Sync")
MA_MEDIA_URL_BASE: str = os.environ.get("MA_MEDIA_URL_BASE", "http://192.168.88.8:9876")


class MusicAssistantClient:
    """Persistent MA client — maintains WS connection and sends HTTP commands."""

    def __init__(self) -> None:
        self._ws_url = MA_URL.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        self._http_url = MA_URL
        self._token = MA_TOKEN
        self._msg_id = 0
        self._ws_task: Optional[asyncio.Task] = None
        self._connected = False

        # group player resolution
        self.group_player_name: str = MA_GROUP_PLAYER
        self.group_player_id: Optional[str] = None   # filled after player discovery
        self._players: dict[str, dict] = {}          # player_id → player object

        # event callbacks: async fn(event_type: str, data: Any)
        self._callbacks: list[Callable] = []

    # ─── Public helpers ────────────────────────────────────────────────────────

    def add_event_callback(self, cb: Callable) -> None:
        self._callbacks.append(cb)

    @property
    def connected(self) -> bool:
        return self._connected

    def resolve_player_id(self, name: str) -> str:
        """Map a display name / 'all' to a MA player_id.
        Falls back to group player id when nothing matches.
        
        If name is already a valid MA player_id (in our cache), return it directly.
        """
        # CRITICAL: First check if name is already a valid player_id in our cache
        # This handles cases where device_name stores actual player_ids like 'syncgroup_gpw4si6j'
        if name and name in self._players:
            return name
        
        # Handle 'all' or empty name - use the actual group player_id
        if name in ("all", self.group_player_name, ""):
            return self.get_group_player_id()
        
        # Search by display name (case-insensitive) - return actual player_id
        for pid, p in self._players.items():
            if p.get("name", "").lower() == name.lower():
                return pid
        
        # If not found and name looks like a group player name, try to find by name pattern
        if name.lower() in ("esp32-sync", "sync group", "group", "sync"):
            return self.get_group_player_id()
        
        # Last resort: return as-is (might be actual player_id from MA)
        return name
    
    def get_group_player_id(self) -> str:
        """Get the actual MA player_id for the group player."""
        if self.group_player_id:
            return self.group_player_id
        for pid, p in self._players.items():
            if p.get("type") == "group":
                return pid
        for pid, p in self._players.items():
            if p.get("available"):
                return pid
        if self._players:
            return next(iter(self._players.keys()))
        return self.group_player_name

    def get_cached_players(self) -> list[dict]:
        return list(self._players.values())

    def get_group_members(self) -> list[dict]:
        """Return individual player members of the sync group (not the group itself)."""
        if not self.group_player_id:
            return []
        group = self._players.get(self.group_player_id, {})
        member_ids = group.get("group_members", [])
        return [self._players[pid] for pid in member_ids if pid in self._players]

    # ─── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._ws_task = asyncio.create_task(self._ws_loop(), name="ma_ws_loop")
        self._poll_task = asyncio.create_task(self._poll_loop(), name="ma_poll_loop")

    async def stop(self) -> None:
        if self._ws_task and not self._ws_task.done():
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass
        if hasattr(self, '_poll_task') and self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass

    async def _poll_loop(self) -> None:
        """Fallback polling to ensure player state is up-to-date since MA v2 WS events may require explicit subscription."""
        while True:
            try:
                await asyncio.sleep(4.0)
                if self._connected:
                    players = await self.get_players()
                    current_pids = set()
                    for p in players:
                        pid = p["player_id"]
                        current_pids.add(pid)
                        old_p = self._players.get(pid)
                        self._players[pid] = p
                        if p.get("name", "").lower() == self.group_player_name.lower():
                            self.group_player_id = pid
                        if p != old_p:
                            await self._fire("player_updated", p)
                    
                    # Remove disappeared players
                    for pid in list(self._players.keys()):
                        if pid not in current_pids:
                            self._players.pop(pid)
                            await self._fire("player_removed", pid)

            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.debug("[MA] Polling error: %s", exc)

    async def _ws_loop(self) -> None:
        """Auto-reconnecting WebSocket listener."""
        retry_delay = 3.0
        while True:
            try:
                await self._ws_connect()
                retry_delay = 3.0  # reset on success
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("[MA] WS error: %s — reconnecting in %.0fs", exc, retry_delay)
            self._connected = False
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 1.5, 30.0)

    async def _ws_connect(self) -> None:
        logger.info("[MA] Connecting to %s", self._ws_url)
        async with websockets.connect(
            self._ws_url,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            # Authenticate
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
            if msg.get("type") == "auth_required":
                self._msg_id += 1
                await ws.send(json.dumps({
                    "message_id": self._msg_id,
                    "command": "auth",
                    "args": {"token": f"Bearer {self._token}"},
                }))
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                resp = json.loads(raw)
                if not resp.get("success", True):
                    raise RuntimeError(f"MA auth failed: {resp}")

            self._connected = True
            logger.info("[MA] WebSocket authenticated ✓")

            # Discover players on (re-)connect
            asyncio.create_task(self._discover_players())

            async for raw in ws:
                try:
                    data = json.loads(raw)
                    await self._handle_ws_message(data)
                except Exception as exc:
                    logger.debug("[MA] WS parse error: %s", exc)

    async def _handle_ws_message(self, msg: dict) -> None:
        event_type = msg.get("type") or msg.get("event")
        if not event_type:
            return

        payload = msg.get("data", msg)

        # Keep local player cache up-to-date
        if event_type in ("player_updated", "player_added"):
            pid = payload.get("player_id")
            if pid:
                self._players[pid] = payload
                # If this is our group player, record its id
                if payload.get("name", "").lower() == self.group_player_name.lower():
                    self.group_player_id = pid
        elif event_type == "player_removed":
            pid = payload.get("player_id") if isinstance(payload, dict) else payload
            self._players.pop(pid, None)

        await self._fire(event_type, payload)

    async def _fire(self, event_type: str, data: Any) -> None:
        for cb in self._callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    await cb(event_type, data)
                else:
                    cb(event_type, data)
            except Exception as exc:
                logger.error("[MA] callback error: %s", exc)

    # ─── Player discovery ──────────────────────────────────────────────────────

    async def _discover_players(self) -> None:
        try:
            players = await self.get_players()
            self._players = {p["player_id"]: p for p in players}
            for p in players:
                if p.get("name", "").lower() == self.group_player_name.lower():
                    self.group_player_id = p["player_id"]
                    logger.info("[MA] Group player '%s' → id '%s'",
                                self.group_player_name, self.group_player_id)
            logger.info("[MA] Discovered %d players", len(players))
        except Exception as exc:
            logger.warning("[MA] Player discovery failed: %s", exc)

    # ─── HTTP RPC ──────────────────────────────────────────────────────────────

    async def command(self, command: str, args: Optional[dict] = None) -> Any:
        """Send an HTTP RPC command to MA and return the result."""
        payload = {"command": command, "args": args or {}}
        headers = {"Authorization": f"Bearer {self._token}"}
        logger.info(f"[MA] RPC: {command} with args: {args}")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{self._http_url}/api",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            result = resp.json()
            logger.info(f"[MA] RPC result: {result}")
            return result

    # ─── Player commands ────────────────────────────────────────────────────────

    async def get_players(self) -> list[dict]:
        result = await self.command("players/all")
        if isinstance(result, list):
            return result
        return []

    async def get_player(self, player_id: str) -> dict:
        result = await self.command("players/get_player", {"player_id": player_id})
        return result if isinstance(result, dict) else {}

    async def get_queue(self, player_id: str) -> dict:
        """Get the active queue for a player."""
        result = await self.command("player_queues/get_active_queue", {"player_id": player_id})
        return result if isinstance(result, dict) else {}

    async def get_queue_items(self, queue_id: str, limit: int = 50) -> list[dict]:
        result = await self.command("player_queues/items",
                                    {"queue_id": queue_id, "limit": limit, "offset": 0})
        if isinstance(result, list):
            return result
        return []

    async def play_media(self, player_id: str, uri: str,
                         name: Optional[str] = None) -> Any:
        """Play media on a player using direct URI format MA expects."""
        # Get the active queue to get queue_id
        queue_id = None
        try:
            queue = await self.get_queue(player_id)
            if isinstance(queue, dict):
                queue_id = queue.get("queue_id")
        except Exception:
            pass
        
        # Fall back to player_id if no queue_id found
        if not queue_id:
            queue_id = player_id
        
        # MA expects media as a list of items or directly as uri
        # Try with queue_id and media items in MA's expected format
        return await self.command("player_queues/play_media", {
            "queue_id": queue_id,
            "media": [uri],  # MA expects list of URIs
            "queue_option": "replace",
        })

    async def play_pause(self, player_id: str) -> Any:
        return await self.command("players/cmd/play_pause", {"player_id": player_id})

    async def pause(self, player_id: str) -> Any:
        return await self.command("players/cmd/pause", {"player_id": player_id})

    async def stop(self, player_id: str) -> Any:
        return await self.command("players/cmd/stop", {"player_id": player_id})

    async def set_volume(self, player_id: str, volume: int) -> Any:
        v = max(0, min(100, int(volume)))
        return await self.command("players/cmd/volume_set",
                                  {"player_id": player_id, "volume_level": v})

    async def seek(self, player_id: str, position: float) -> Any:
        return await self.command("players/cmd/seek",
                                  {"player_id": player_id, "position": float(position)})

    async def next_track(self, player_id: str) -> Any:
        return await self.command("players/cmd/next", {"player_id": player_id})

    async def previous_track(self, player_id: str) -> Any:
        return await self.command("players/cmd/previous", {"player_id": player_id})

    async def power_toggle(self, player_id: str, powered: bool) -> Any:
        return await self.command("players/cmd/power", {"player_id": player_id, "powered": powered})

    async def set_repeat(self, queue_id: str, repeat_mode: str) -> Any:
        # repeat_mode: "off" | "one" | "all"
        return await self.command("player_queues/set_repeat",
                                  {"queue_id": queue_id, "repeat_mode": repeat_mode})

    async def set_shuffle(self, queue_id: str, shuffle: bool) -> Any:
        return await self.command("player_queues/set_shuffle",
                                  {"queue_id": queue_id, "shuffle_enabled": shuffle})


# ─── Module-level singleton ────────────────────────────────────────────────────
ma_client = MusicAssistantClient()
