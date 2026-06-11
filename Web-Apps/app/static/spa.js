// app/static/spa.js
// Audio-Auto with Music Assistant - SPA frontend
// All playback is controlled via /api/ma/* which proxies to Music Assistant.

document.addEventListener('DOMContentLoaded', () => {

    const mainContent = document.getElementById('spa-content');
    const bottomPlayer = document.getElementById('bottom-player');

    // ─── Global function stubs (defined immediately for onclick handlers) ──────────
    window.openDeviceModal = function() { console.warn('SPA initializing...'); };
    window.closeDeviceModal = function() {};
    window.renderDeviceModalList = function() {};
    window.selectMAPlayer = function() {};
    window.applyDeviceSelection = function() {};
    window.selectAllDevices = function() {};
    window.deselectAllDevices = function() {};
    window.setMAQueueMode = function() {};
    window.openUploadModal = function() {};
    window.handleFileDrop = function() {};
    window.handleFileSelect = function() {};
    window.selectSong = function() {};
    window.deleteFile = function() {};
    window.setSchedRepeat = function() {};
    window.openScheduleModal = function() {};
    window.closeScheduleModal = function() {};
    window.deleteSchedule = function() {};
    window.maDevCmd = function() {};

    // ─── Global MA State ───────────────────────────────────────────────────────
    window.maState = {
        players: {},
        groupPlayerId: null,
        selectedPlayerId: null,
        connected: false,
    };

    window.allFiles = [];
    window.playQueue = [];

    // ─── Element references ────────────────────────────────────────────────────
    const miniBtnPlay = document.getElementById('miniBtnPlay');
    const miniPlayIcon = document.getElementById('miniPlayIcon');
    const miniBtnNext = document.getElementById('miniBtnNext');
    const miniBtnPrev = document.getElementById('miniBtnPrev');
    const miniSongTitle = document.getElementById('miniSongTitle');
    const miniTimeElapsed = document.getElementById('miniTimeElapsed');
    const miniTimeTotal = document.getElementById('miniTimeTotal');
    const miniProgressOverlay = document.getElementById('miniProgressOverlay');
    const miniVolSlider = document.getElementById('miniVolSlider');

    // ─── WaveSurfer (singleton) ──────────────────────────────────────────────
    let wavesurfer = null;
    let wavesurferInitialized = false;
    let currentLoadedFileId = null;
    const globalWaveformContainer = document.createElement('div');
    globalWaveformContainer.id = 'persistentWaveform';

    // Guards to prevent WaveSurfer ↔ MA seek feedback loops
    let _programmaticSeek = false;      // true while we're syncing WS position
    let _lastSyncCorrection = 0;        // timestamp of last drift correction
    const SYNC_DEBOUNCE_MS = 2000;      // suppress auto-corrections for 2s after one
    const SYNC_DEBOUNCE_USER_MS = 5000; // suppress corrections for 5s after USER seek
    const DRIFT_THRESHOLD_S = 3.0;      // only correct if drift > 3 seconds
    let _lastKnownPlaybackState = null; // track state to avoid redundant play/pause

    // ─── Routing ──────────────────────────────────────────────────────────────
    function updatePlayerVisibility(url) {
        if (url === '/' || url === '') {
            if (bottomPlayer) bottomPlayer.classList.add('hidden');
        } else {
            const playing = Object.values(window.maState.players).some(
                p => p.playback_state === 'playing' || p.playback_state === 'paused'
            );
            if (playing && bottomPlayer) bottomPlayer.classList.remove('hidden');
        }
    }

    function navigateTo(url) {
        history.pushState(null, '', url);
        loadPage(url);
    }

    function loadPage(url) {
        fetch(url)
            .then(r => r.text())
            .then(html => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const newContent = doc.getElementById('spa-content');
                if (newContent && mainContent) {
                    mainContent.innerHTML = newContent.innerHTML;
                    mainContent.querySelectorAll('script').forEach(oldScript => {
                        const newScript = document.createElement('script');
                        if (oldScript.src) newScript.src = oldScript.src;
                        else newScript.textContent = oldScript.textContent;
                        document.body.appendChild(newScript);
                        document.body.removeChild(newScript);
                    });
                    if (window.applyLanguage) window.applyLanguage();
                    window.initPageScripts(url);
                    updatePlayerVisibility(url);
                }
            })
            .catch(e => console.error('SPA load error:', e));
    }

    window.addEventListener('popstate', () => loadPage(location.pathname));

    document.body.addEventListener('click', e => {
        const link = e.target.closest('a.spa-link');
        if (link) {
            e.preventDefault();
            navigateTo(link.getAttribute('href'));
        }
    });

    // ─── WebSocket ────────────────────────────────────────────────────────────
    let ws = null;
    let wsReconnectTimer = null;

    function connectWebSocket() {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + location.host + '/ws');

        ws.onopen = () => console.log('[WS] Connected');

        ws.onmessage = evt => {
            try {
                const msg = JSON.parse(evt.data);
                handleWsMessage(msg);
            } catch (e) { console.error('[WS] Parse error:', e); }
        };

        ws.onclose = () => { wsReconnectTimer = setTimeout(connectWebSocket, 3000); };
        ws.onerror = () => ws.close();
    }

    function handleWsMessage(msg) {
        const t = msg.type;

        if (t === 'ma_players_snapshot') {
            if (Array.isArray(msg.players)) {
                msg.players.forEach(p => { window.maState.players[p.player_id] = p; });
                _resolveGroupPlayer();
                updateUIFromMA();
            }
        } else if (t === 'ma_player') {
            const p = msg.player;
            if (!p || !p.player_id) return;
            window.maState.players[p.player_id] = p;
            if (msg.event === 'player_removed') delete window.maState.players[p.player_id];
            _resolveGroupPlayer();
            updateUIFromMA();
        } else if (t === 'ma_queue_time') {
            const d = msg.data || {};
            const activePlayer = getActivePlayer();
            if (activePlayer && (activePlayer.player_id === d.queue_id || activePlayer.current_queue_id === d.queue_id)) {
                activePlayer.elapsed_time = d.elapsed_time;
                activePlayer.elapsed_time_last_updated = d.elapsed_time_last_updated || (Date.now() / 1000);
            }
            _updateProgressBar();
        } else if (t === 'transcode_progress') {
            if (msg.status === 'started') {
                Swal.fire({ title: 'Transcoding', html: '<b>' + msg.file + '</b>...', allowOutsideClick: false, showConfirmButton: false, customClass: { popup: 'glass' } });
            } else if (msg.status === 'done') {
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Transcoding done', showConfirmButton: false, timer: 3000 });
                fetch('/api/files').then(r => r.json()).then(files => { window.allFiles = files; renderPlaylist(files); });
            } else if (msg.status === 'error') {
                Swal.fire('Transcode Failed', msg.file, 'error');
            }
        }
    }

    function _resolveGroupPlayer() {
        const cached = Object.values(window.maState.players).find(p =>
            (p.is_group || p.type === 'group') &&
            (p.player_id === window.maState.groupPlayerId || p.in_sync_group ||
             (p.name || '').toLowerCase().includes('esp32'))
        );
        if (cached) {
            window.maState.groupPlayerId = cached.player_id;
            if (!window.maState.selectedPlayerId) window.maState.selectedPlayerId = cached.player_id;
        }
    }

    function getActivePlayer() {
        const pid = window.maState.selectedPlayerId || window.maState.groupPlayerId;
        return pid ? (window.maState.players[pid] || null) : null;
    }

    // ─── UI Update ───────────────────────────────────────────────────────────
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '0:00';
        return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
    }

    function updateUIFromMA() {
        const player = getActivePlayer();
        if (!player) return;

        const isPlaying = player.playback_state === 'playing';
        const isPaused = player.playback_state === 'paused';
        const media = player.current_media;

        let title = 'Ready';
        let artist = 'Audio-Auto → Music Assistant';
        if (media) {
            title = media.title || _filenameToTitle(media.uri || '') || 'Playing…';
            artist = media.artist || (isPlaying ? 'Playing via MA' : 'Paused');
        }

        if (miniSongTitle) miniSongTitle.textContent = title;
        if (miniPlayIcon) miniPlayIcon.className = isPlaying ? 'fas fa-pause-circle text-2xl md:text-3xl' : 'fas fa-play-circle text-2xl md:text-3xl';

        const bigTitle = document.getElementById('nowPlaying');
        if (bigTitle) bigTitle.textContent = title;
        const bigArtist = document.getElementById('nowPlayingArtist');
        if (bigArtist) bigArtist.textContent = artist;
        const bigPlayIcon = document.getElementById('playIcon');
        if (bigPlayIcon) bigPlayIcon.className = isPlaying ? 'fas fa-pause-circle text-5xl md:text-6xl drop-shadow-md' : 'fas fa-play-circle text-5xl md:text-6xl drop-shadow-md';

        const vol = player.group_volume ?? player.volume_level ?? 50;
        const volSlider = document.getElementById('volSlider');
        if (volSlider && document.activeElement !== volSlider) volSlider.value = vol;
        if (miniVolSlider && document.activeElement !== miniVolSlider) miniVolSlider.value = vol;

        if (media && media.uri) {
            const matchedFile = _matchUriToFile(media.uri);
            if (matchedFile && matchedFile.id !== currentLoadedFileId && wavesurfer) {
                currentLoadedFileId = matchedFile.id;
                wavesurfer.load('/audio_files/' + encodeURIComponent(matchedFile.filename)).catch(e => { if (e.name !== 'AbortError') console.warn(e); });
                _highlightPlaylist(matchedFile.id);
            }
            if (media.duration) {
                if (miniTimeTotal) miniTimeTotal.textContent = formatTime(media.duration);
                const timeTotal = document.getElementById('timeTotal');
                if (timeTotal) timeTotal.textContent = formatTime(media.duration);
            }
        }

        // Only toggle WaveSurfer play/pause on actual state transitions to
        // avoid the rapid play/pause cycling that causes stutter.
        if (wavesurfer && currentLoadedFileId) {
            const stateKey = player.player_id + ':' + player.playback_state;
            if (stateKey !== _lastKnownPlaybackState) {
                _lastKnownPlaybackState = stateKey;
                if (isPlaying && !wavesurfer.isPlaying()) {
                    wavesurfer.play().catch(() => {});
                } else if (!isPlaying && wavesurfer.isPlaying()) {
                    wavesurfer.pause();
                }
            }
        }

        if ((isPlaying || isPaused) && location.pathname !== '/' && bottomPlayer) bottomPlayer.classList.remove('hidden');
        _updateMaStatusPanel();
    }

    function _updateProgressBar() {
        const player = getActivePlayer();
        if (!player) return;
        let elapsed = player.elapsed_time || 0;
        if (player.playback_state === 'playing' && player.elapsed_time_last_updated) {
            elapsed += (Date.now() / 1000) - player.elapsed_time_last_updated;
        }
        const dur = (player.current_media && player.current_media.duration) || 0;

        if (miniTimeElapsed) miniTimeElapsed.textContent = formatTime(elapsed);
        const timeElapsed = document.getElementById('timeElapsed');
        if (timeElapsed) timeElapsed.textContent = formatTime(elapsed);

        if (dur > 0) {
            const pct = Math.min((elapsed / dur) * 100, 100);
            if (miniProgressOverlay) miniProgressOverlay.style.width = pct + '%';
            // Only correct WaveSurfer position when drift is large (> 3s)
            // and debounce to prevent rapid seek corrections that cause stutter.
            if (wavesurfer && wavesurfer.getDuration() > 0) {
                const wsTime = wavesurfer.getCurrentTime();
                const drift = Math.abs(wsTime - elapsed);
                const now = Date.now();
                if (drift > DRIFT_THRESHOLD_S && (now - _lastSyncCorrection) > SYNC_DEBOUNCE_MS) {
                    _lastSyncCorrection = now;
                    _programmaticSeek = true;
                    wavesurfer.seekTo(Math.min(elapsed / wavesurfer.getDuration(), 1));
                    setTimeout(() => { _programmaticSeek = false; }, 300);
                }
            }
        }
    }

    setInterval(_updateProgressBar, 250);

    function _updateMaStatusPanel() {
        const panel = document.getElementById('maStatusPanel');
        if (!panel) return;
        const players = Object.values(window.maState.players);
        if (players.length === 0) { panel.innerHTML = '<div class="text-sm text-gray-500 text-center py-4">No MA players discovered yet…</div>'; return; }
        panel.innerHTML = players.filter(p => p.in_sync_group || p.is_group).map(p => {
            const state = p.playback_state || 'idle';
            const vol = p.group_volume ?? p.volume_level ?? '?';
            const color = { playing: 'text-green-500', paused: 'text-yellow-500', idle: 'text-gray-400' }[state] || 'text-gray-400';
            const icon = { playing: 'fa-play', paused: 'fa-pause', idle: 'fa-stop' }[state] || 'fa-question';
            return '<div class="flex justify-between items-center p-2 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 mb-2"><div class="flex items-center gap-2"><i class="fas ' + icon + ' ' + color + ' text-sm"></i><span class="font-medium text-sm">' + (p.name || p.player_id) + '</span>' + (p.is_group ? '<span class="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">Group</span>' : '') + '</div><div class="flex items-center gap-3 text-xs font-mono"><span class="' + color + '">' + state + '</span><span class="text-gray-500"><i class="fas fa-volume-up mr-1"></i>' + vol + '%</span></div></div>';
        }).join('') || '<div class="text-sm text-gray-500 text-center py-4">No ESP32-Sync players visible.</div>';
    }

    function _filenameToTitle(uri) {
        const parts = uri.split('/');
        return decodeURIComponent(parts[parts.length - 1] || '').replace(/\.[^.]+$/, '');
    }

    function _matchUriToFile(uri) {
        return window.allFiles.find(f => uri.includes(encodeURIComponent(f.filename)) || uri.includes(f.filename));
    }

    function _highlightPlaylist(fileId) {
        document.querySelectorAll('#playlistContainer > div').forEach(el => {
            el.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
        });
        const active = document.querySelector('#playlistContainer > div[data-id="' + fileId + '"]');
        if (active) active.classList.add('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
    }

    // ─── API wrappers ─────────────────────────────────────────────────────────
    async function maPost(path, fields) {
        // Check if all target players are available before sending command
        const playerId = fields.player_id || pid();
        const player = window.maState.players[playerId];
        
        // Check individual group members for availability
        const syncPlayers = Object.values(window.maState.players).filter(p => p.in_sync_group);
        const unavailablePlayers = syncPlayers.filter(p => !p.available);
        
        if (unavailablePlayers.length > 0 && path !== 'players') {
            const names = unavailablePlayers.map(p => p.name || p.player_id).join(', ');
            Swal.fire({
                icon: 'warning',
                title: 'Speaker(s) Not Ready',
                html: 'The following speaker(s) are offline and cannot receive commands:<br><b>' + names + '</b>',
                confirmButtonText: 'OK'
            });
            console.warn('[MA] Unavailable players:', unavailablePlayers.map(p => p.player_id));
        }
        
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        
        try {
            const response = await fetch('/api/ma/' + path, { method: 'POST', body: fd });
            
            // Handle 502 Bad Gateway (player unavailable) or other errors
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                
                if (response.status === 502 || errorText.includes('not available') || errorText.includes('unavailable')) {
                    Swal.fire({
                        icon: 'error',
                        title: 'Player Unavailable',
                        text: 'One or more speakers are not ready. Please wait for all speakers to connect.',
                        confirmButtonText: 'OK'
                    });
                }
                throw new Error(errorText);
            }
            
            return response;
        } catch (e) {
            console.error('[MA] Command failed:', e.message);
            throw e;
        }
    }

    function pid() {
        const selected = window.maState.selectedPlayerId;
        const group = window.maState.groupPlayerId;
        if (selected && window.maState.players[selected]) return selected;
        if (group && window.maState.players[group]) return group;
        const cachedIds = Object.keys(window.maState.players);
        if (cachedIds.length > 0) {
            const groupPlayer = cachedIds.find(id => window.maState.players[id]?.is_group);
            return groupPlayer || cachedIds[0];
        }
        return selected || group || 'ESP32-Sync';
    }

    // ─── Playback controls ────────────────────────────────────────────────────
    window.selectSong = function(id) {
        const file = window.allFiles.find(f => f.id === id);
        if (!file) return;
        if (wavesurfer) {
            currentLoadedFileId = id;
            wavesurfer.load('/audio_files/' + encodeURIComponent(file.filename)).catch(e => { if (e.name !== 'AbortError') console.warn(e); });
        }
        _highlightPlaylist(id);
        maPost('play', { player_id: pid(), audio_id: id });
    };

    function togglePlay() {
        const player = getActivePlayer();
        if (!player) { if (window.allFiles.length > 0) window.selectSong(window.allFiles[0].id); return; }
        maPost('play_pause', { player_id: pid() });
    }

    function stopPlayback() { maPost('stop', { player_id: pid() }); if (wavesurfer) wavesurfer.seekTo(0); }

    function playNext() {
        const player = getActivePlayer();
        if (player && player.current_media) { maPost('next', { player_id: pid() }); return; }
        if (window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => _matchUriToFile(player?.current_media?.uri || '') === f);
        idx = (idx + 1) % window.allFiles.length;
        window.selectSong(window.allFiles[idx].id);
    }

    function playPrev() {
        const player = getActivePlayer();
        if (player && player.current_media) { maPost('prev', { player_id: pid() }); return; }
        if (window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => _matchUriToFile(player?.current_media?.uri || '') === f);
        idx = (idx - 1 + window.allFiles.length) % window.allFiles.length;
        window.selectSong(window.allFiles[idx].id);
    }

    function setVolume(vol) { maPost('volume', { player_id: pid(), volume: Math.round(vol) }); }
    function seekTo(position) { maPost('seek', { player_id: pid(), position }); }

    // ─── Device selection modal ────────────────────────────────────────────────
    window.openDeviceModal = function() {
        const modal = document.getElementById('deviceModal');
        const content = document.getElementById('deviceModalContent');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => { if (content) content.classList.remove('scale-95', 'opacity-0'), content.classList.add('scale-100', 'opacity-100'); }, 10);
        window.renderDeviceModalList();
    };

    window.closeDeviceModal = function() {
        const modal = document.getElementById('deviceModal');
        const content = document.getElementById('deviceModalContent');
        if (!modal) return;
        if (content) { content.classList.remove('scale-100', 'opacity-100'); content.classList.add('scale-95', 'opacity-0'); }
        setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 300);
    };

    window.renderDeviceModalList = function() {
        const list = document.getElementById('deviceModalList');
        if (!list) return;
        fetch('/api/ma/players').then(r => r.json()).then(players => {
            const groupPlayer = players.find(p => p.is_group && p.in_sync_group);
            const groupMembers = groupPlayer ? players.filter(p => p.in_sync_group && !p.is_group) : [];
            let html = '';
            if (groupPlayer) {
                const sel = window.maState.selectedPlayerId === groupPlayer.player_id;
                html += '<div onclick="window.selectMAPlayer(\'' + groupPlayer.player_id + '\')" class="flex items-center justify-between p-3 rounded-lg border ' + (sel ? 'border-primary bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800') + ' cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 mb-2"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-full ' + (groupPlayer.available ? 'bg-blue-100 text-blue-600' : 'bg-red-100 text-red-600') + ' flex items-center justify-center"><i class="fas fa-layer-group text-xs"></i></div><div><h4 class="font-semibold text-sm">' + groupPlayer.name + ' (Group)</h4><p class="text-xs text-gray-500">' + (groupPlayer.available ? groupPlayer.playback_state : 'Offline') + '</p></div></div><i class="fas ' + (sel ? 'fa-check-circle text-primary' : 'fa-circle text-gray-300') + '"></i></div>';
            }
            if (groupMembers.length > 0) {
                html += '<div class="text-xs text-gray-500 px-1 mb-1">Individual Speakers:</div>';
                html += groupMembers.map(p => {
                    const sel = window.maState.selectedPlayerId === p.player_id;
                    return '<div onclick="window.selectMAPlayer(\'' + p.player_id + '\')" class="flex items-center justify-between p-3 rounded-lg border ' + (sel ? 'border-primary bg-blue-50' : 'border-gray-200 bg-white') + ' cursor-pointer hover:bg-gray-50 mb-1"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-full ' + (p.available ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600') + ' flex items-center justify-center"><i class="fas fa-speaker text-xs"></i></div><div><h4 class="font-semibold text-sm">' + p.name + '</h4><p class="text-xs text-gray-500">' + (p.available ? p.playback_state : 'Offline') + '</p></div></div><i class="fas ' + (sel ? 'fa-check-circle text-primary' : 'fa-circle text-gray-300') + '"></i></div>';
                }).join('');
            }
            if (!groupPlayer && groupMembers.length === 0) html = '<div class="text-center text-sm text-gray-500 py-4">No ESP32-Sync players discovered yet.</div>';
            list.innerHTML = html;
        }).catch(() => { list.innerHTML = '<div class="text-center text-sm text-red-500 py-4">Failed to load players.</div>'; });
    };

    window.selectMAPlayer = function(playerId) {
        window.maState.selectedPlayerId = playerId;
        const player = window.maState.players[playerId];
        const text = document.getElementById('selectedDeviceText');
        if (text && player) text.textContent = player.name || playerId;
        window.renderDeviceModalList();
    };

    window.applyDeviceSelection = function() { window.closeDeviceModal(); };
    window.selectAllDevices = function() { const g = window.maState.groupPlayerId; if (g) window.selectMAPlayer(g); };
    window.deselectAllDevices = function() {};

    // ─── Playlist ─────────────────────────────────────────────────────────────
    function renderPlaylist(files) {
        const container = document.getElementById('playlistContainer');
        if (!container) return;
        if (!files || files.length === 0) { container.innerHTML = '<div class="p-8 text-center text-gray-500">No files uploaded yet.</div>'; return; }
        const activePlayer = getActivePlayer();
        const activeUri = activePlayer?.current_media?.uri || '';
        container.innerHTML = files.map(f => {
            const isActive = activeUri && (activeUri.includes(encodeURIComponent(f.filename)) || activeUri.includes(f.filename));
            const dur = f.duration_sec ? formatTime(f.duration_sec) : '?:??';
            return '<div data-id="' + f.id + '" class="flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors gap-3 ' + (isActive ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-primary' : '') + '" onclick="window.selectSong(' + f.id + ')"><div class="flex items-center gap-3 min-w-0"><div class="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center shrink-0"><i class="fas fa-music text-blue-400 text-xs"></i></div><div class="min-w-0"><p class="font-medium text-gray-800 dark:text-gray-200 truncate text-sm">' + f.original_name + '</p><p class="text-xs text-gray-500">' + dur + '</p></div></div><div class="flex items-center gap-2 shrink-0">' + (isActive ? '<i class="fas fa-volume-up text-primary text-sm"></i>' : '') + '<button onclick="event.stopPropagation(); deleteFile(' + f.id + ')" class="text-gray-300 hover:text-red-500 p-1"><i class="fas fa-trash text-xs"></i></button></div></div>';
        }).join('');
    }

    window.deleteFile = function(id) {
        Swal.fire({ title: 'Delete file?', icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', confirmButtonText: 'Delete' }).then(res => {
            if (res.isConfirmed) fetch('/api/files/' + id, { method: 'DELETE' }).then(() => { window.allFiles = window.allFiles.filter(f => f.id !== id); renderPlaylist(window.allFiles); });
        });
    };

    // ─── Upload Modal ─────────────────────────────────────────────────────────
    window.openUploadModal = function() {
        // Fetch config to determine accepted formats based on transcode setting
        fetch('/api/config').then(r => r.json()).then(conf => {
            const transcodeOn = conf && conf.transcode_enabled;
            const streamReady = '.mp3,.wav,.flac,.aac,.ogg';
            const allFormats = streamReady + ',.mp4,.m4a,.mkv,.webm,.avi,.mov,.wma,.opus,.mpeg,.mpg,.ts,.mka,.3gp,.amr,.ape,.dts,.ac3';
            const acceptAttr = transcodeOn ? allFormats : streamReady;
            const supportedText = transcodeOn
                ? 'All audio/video formats (transcode enabled)'
                : 'Supported: mp3, wav, flac, aac, ogg';
            Swal.fire({
                title: '<i class="fas fa-cloud-upload-alt mr-2 text-primary"></i>Upload Music',
                html: '<div class="text-left space-y-4"><div id="dropZone" class="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-8 text-center cursor-pointer hover:border-primary transition-colors" ondragover="event.preventDefault()" ondrop="handleFileDrop(event)" onclick="document.getElementById(\'uploadFileInput\').click()"><i class="fas fa-music text-4xl text-gray-400 mb-3 block"></i><p class="text-gray-600 dark:text-gray-400 text-sm">Click or drag & drop to upload</p><p class="text-xs text-gray-500 mt-2">' + supportedText + '</p></div><input type="file" id="uploadFileInput" accept="' + acceptAttr + '" class="hidden" onchange="handleFileSelect(event)"><div id="uploadProgress" class="hidden"><div class="flex items-center gap-2 text-sm text-primary"><i class="fas fa-spinner fa-spin"></i><span id="uploadProgressText">Uploading…</span></div><div class="w-full h-1 bg-gray-200 rounded-full mt-2"><div id="uploadProgressBar" class="h-1 bg-primary rounded-full transition-all" style="width:0%"></div></div></div></div>',
                showConfirmButton: false, showCloseButton: true, customClass: { popup: 'glass' }
            });
        }).catch(() => {
            // Fallback: show stream-ready only
            Swal.fire({
                title: '<i class="fas fa-cloud-upload-alt mr-2 text-primary"></i>Upload Music',
                html: '<div class="text-left space-y-4"><div id="dropZone" class="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-8 text-center cursor-pointer hover:border-primary transition-colors" ondragover="event.preventDefault()" ondrop="handleFileDrop(event)" onclick="document.getElementById(\'uploadFileInput\').click()"><i class="fas fa-music text-4xl text-gray-400 mb-3 block"></i><p class="text-gray-600 dark:text-gray-400 text-sm">Click or drag & drop to upload</p><p class="text-xs text-gray-500 mt-2">Supported: mp3, wav, flac, aac, ogg</p></div><input type="file" id="uploadFileInput" accept=".mp3,.wav,.flac,.aac,.ogg" class="hidden" onchange="handleFileSelect(event)"><div id="uploadProgress" class="hidden"><div class="flex items-center gap-2 text-sm text-primary"><i class="fas fa-spinner fa-spin"></i><span id="uploadProgressText">Uploading…</span></div><div class="w-full h-1 bg-gray-200 rounded-full mt-2"><div id="uploadProgressBar" class="h-1 bg-primary rounded-full transition-all" style="width:0%"></div></div></div></div>',
                showConfirmButton: false, showCloseButton: true, customClass: { popup: 'glass' }
            });
        });
    };

    window.handleFileDrop = function(event) {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) _doUpload(file);
    };

    window.handleFileSelect = function(event) {
        const file = event.target.files[0];
        if (file) _doUpload(file);
    };

    function _doUpload(file) {
        const fn = document.getElementById('selectedFileName');
        if (fn) fn.textContent = file.name;
        const progress = document.getElementById('uploadProgress');
        const bar = document.getElementById('uploadProgressBar');
        const txt = document.getElementById('uploadProgressText');
        if (progress) progress.classList.remove('hidden');
        if (txt) txt.textContent = 'Uploading ' + file.name + '…';
        const fd = new FormData();
        fd.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = e => { if (e.lengthComputable && bar) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
        xhr.onload = () => {
            Swal.close();
            if (xhr.status === 200) {
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Uploaded!', showConfirmButton: false, timer: 3000 });
                fetch('/api/files').then(r => r.json()).then(files => { window.allFiles = files; renderPlaylist(files); });
            } else Swal.fire('Upload Failed', xhr.responseText, 'error');
        };
        xhr.onerror = () => Swal.fire('Upload Error', 'Network error.', 'error');
        xhr.send(fd);
    }

    // ─── WaveSurfer ──────────────────────────────────────────────────────────
    function initWaveSurfer() {
        const container = document.getElementById('waveformContainer');
        if (!container || typeof WaveSurfer === 'undefined') return;
        container.innerHTML = '';
        container.appendChild(globalWaveformContainer);
        if (wavesurferInitialized) return;
        wavesurferInitialized = true;
        wavesurfer = WaveSurfer.create({
            container: globalWaveformContainer,
            waveColor: 'rgba(59, 130, 246, 0.4)',
            progressColor: 'rgba(59, 130, 246, 1)',
            barWidth: 2, barGap: 2, barRadius: 2,
            height: 64, normalize: true, interact: true
        });
        // Only send MA seek when the user intentionally clicks/drags the
        // waveform — NOT during programmatic position corrections.
        wavesurfer.on('interaction', () => {
            if (_programmaticSeek) return; // ignore programmatic seeks
            if (wavesurfer.getDuration() > 0) {
                _lastSyncCorrection = Date.now() + SYNC_DEBOUNCE_USER_MS - SYNC_DEBOUNCE_MS; // 5s debounce after user seek
                seekTo(wavesurfer.getCurrentTime());
            }
        });
        wavesurfer.on('ready', () => {
            const dur = wavesurfer.getDuration();
            const tt = document.getElementById('timeTotal');
            if (tt) tt.textContent = formatTime(dur);
            if (miniTimeTotal) miniTimeTotal.textContent = formatTime(dur);
        });
    }

    // ─── Polling intervals for auto-refresh ──────────────────────────────────
    let _playlistRefreshInterval = null;
    let _playerStatePollInterval = null;

    function startPlaylistPolling() {
        // Clear any existing interval first
        if (_playlistRefreshInterval) clearInterval(_playlistRefreshInterval);
        // Poll playlist every 10 seconds
        _playlistRefreshInterval = setInterval(() => {
            fetch('/api/files').then(r => r.json()).then(files => {
                const oldIds = new Set(window.allFiles.map(f => f.id));
                const newIds = new Set(files.map(f => f.id));
                // Only re-render if there are changes
                if (oldIds.size !== newIds.size || [...oldIds].some(id => !newIds.has(id))) {
                    window.allFiles = files;
                    const search = document.getElementById('searchInput');
                    const q = search ? search.value.toLowerCase() : '';
                    renderPlaylist(q ? files.filter(f => f.original_name.toLowerCase().includes(q)) : files);
                    console.log('[Playlist] Auto-refreshed - new file count:', files.length);
                }
            }).catch(() => {});
        }, 10000);
    }

    function startPlayerStatePolling() {
        // Clear any existing interval first
        if (_playerStatePollInterval) clearInterval(_playerStatePollInterval);
        // Poll player state every 5 seconds as WebSocket backup
        _playerStatePollInterval = setInterval(() => {
            fetch('/api/ma/players').then(r => r.json()).then(players => {
                let changed = false;
                players.forEach(p => {
                    const old = window.maState.players[p.player_id];
                    if (!old || JSON.stringify(old) !== JSON.stringify(p)) {
                        window.maState.players[p.player_id] = p;
                        changed = true;
                    }
                });
                if (changed) {
                    _resolveGroupPlayer();
                    updateUIFromMA();
                }
            }).catch(() => {});
        }, 5000);
    }

    // ─── Page init functions ──────────────────────────────────────────────────
    function initDashboard() {
        console.log('[Dashboard] Initializing...');
        
        fetch('/api/files').then(r => r.json()).then(files => { window.allFiles = files; renderPlaylist(files); });
        initWaveSurfer();
        fetch('/api/ma/players').then(r => r.json()).then(players => {
            players.forEach(p => { window.maState.players[p.player_id] = p; });
            _resolveGroupPlayer();
            updateUIFromMA();
            const gp = window.maState.groupPlayerId ? window.maState.players[window.maState.groupPlayerId] : null;
            const txt = document.getElementById('selectedDeviceText');
            if (txt && gp) txt.textContent = gp.name;
        });

        // Start auto-polling for playlist and player state
        startPlaylistPolling();
        startPlayerStatePolling();

        // Dashboard player controls - bind with debug logging
        const btnPlay = document.getElementById('btnPlay');
        if (btnPlay) {
            btnPlay.addEventListener('click', () => { console.log('[Dashboard] Play clicked'); togglePlay(); });
            console.log('[Dashboard] btnPlay bound');
        } else {
            console.warn('[Dashboard] btnPlay not found');
        }
        
        const btnStop = document.getElementById('btnStop');
        if (btnStop) {
            btnStop.addEventListener('click', () => { console.log('[Dashboard] Stop clicked'); stopPlayback(); });
            console.log('[Dashboard] btnStop bound');
        }
        
        const btnNext = document.getElementById('btnNext');
        if (btnNext) {
            btnNext.addEventListener('click', () => { console.log('[Dashboard] Next clicked'); playNext(); });
            console.log('[Dashboard] btnNext bound');
        }
        
        const btnPrev = document.getElementById('btnPrev');
        if (btnPrev) {
            btnPrev.addEventListener('click', () => { console.log('[Dashboard] Prev clicked'); playPrev(); });
            console.log('[Dashboard] btnPrev bound');
        }

        const volSlider = document.getElementById('volSlider');
        if (volSlider) {
            const player = getActivePlayer();
            if (player) volSlider.value = player.group_volume ?? player.volume_level ?? 50;
            volSlider.addEventListener('change', e => { console.log('[Dashboard] Volume changed to', e.target.value); setVolume(e.target.value); });
            console.log('[Dashboard] volSlider bound');
        }

        const volIcon = document.getElementById('volIcon');
        if (volIcon) {
            volIcon.addEventListener('click', () => {
                console.log('[Dashboard] Volume icon clicked');
                const player = getActivePlayer();
                setVolume((player?.group_volume ?? player?.volume_level ?? 50) > 0 ? 0 : 50);
            });
            console.log('[Dashboard] volIcon bound');
        }

        const search = document.getElementById('searchInput');
        if (search) search.addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            renderPlaylist(window.allFiles.filter(f => f.original_name.toLowerCase().includes(q)));
        });
        
        // Also bind bottom player controls here
        bindBottomPlayerControls();
        
        console.log('[Dashboard] Initialization complete');
    }
    
    // ─── Bottom player bindings (called from initDashboard and also standalone) ──────────
    function bindBottomPlayerControls() {
        const miniPlay = document.getElementById('miniBtnPlay');
        if (miniPlay) {
            // Remove existing listeners by cloning
            const newMiniPlay = miniPlay.cloneNode(true);
            miniPlay.parentNode.replaceChild(newMiniPlay, miniPlay);
            newMiniPlay.addEventListener('click', () => { console.log('[BottomPlayer] Play clicked'); togglePlay(); });
            console.log('[BottomPlayer] miniBtnPlay bound');
        }
        
        const miniNext = document.getElementById('miniBtnNext');
        if (miniNext) {
            const newMiniNext = miniNext.cloneNode(true);
            miniNext.parentNode.replaceChild(newMiniNext, miniNext);
            newMiniNext.addEventListener('click', () => { console.log('[BottomPlayer] Next clicked'); playNext(); });
            console.log('[BottomPlayer] miniBtnNext bound');
        }
        
        const miniPrev = document.getElementById('miniBtnPrev');
        if (miniPrev) {
            const newMiniPrev = miniPrev.cloneNode(true);
            miniPrev.parentNode.replaceChild(newMiniPrev, miniPrev);
            newMiniPrev.addEventListener('click', () => { console.log('[BottomPlayer] Prev clicked'); playPrev(); });
            console.log('[BottomPlayer] miniBtnPrev bound');
        }
        
        const miniStop = document.getElementById('miniBtnStop');
        if (miniStop) {
            const newMiniStop = miniStop.cloneNode(true);
            miniStop.parentNode.replaceChild(newMiniStop, miniStop);
            newMiniStop.addEventListener('click', () => { console.log('[BottomPlayer] Stop clicked'); stopPlayback(); });
            console.log('[BottomPlayer] miniBtnStop bound');
        }
        
        const miniVol = document.getElementById('miniVolSlider');
        if (miniVol) {
            const newMiniVol = miniVol.cloneNode(true);
            miniVol.parentNode.replaceChild(newMiniVol, miniVol);
            newMiniVol.addEventListener('change', e => { console.log('[BottomPlayer] Volume changed to', e.target.value); setVolume(e.target.value); });
            console.log('[BottomPlayer] miniVolSlider bound');
        }
        
        // Progress bar click for seeking
        const miniProgressBar = document.getElementById('miniProgressBarContainer');
        if (miniProgressBar) {
            miniProgressBar.style.cursor = 'pointer';
            miniProgressBar.onclick = function(e) {
                const rect = miniProgressBar.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                const player = getActivePlayer();
                const dur = player?.current_media?.duration || 0;
                if (dur > 0) {
                    const pos = pct * dur;
                    console.log('[BottomPlayer] Seek to', pos.toFixed(1), 's');
                    seekTo(pos);
                }
            };
            console.log('[BottomPlayer] miniProgressBarContainer bound');
        }
    }

    function initDevices() {
        function loadMAPlayers() {
            fetch('/api/ma/players').then(r => r.json()).then(players => {
                players.forEach(p => { window.maState.players[p.player_id] = p; });
                const grid = document.getElementById('maPlayerGrid');
                if (!grid) return;
                const syncPlayers = players.filter(p => p.in_sync_group || p.is_group);
                if (syncPlayers.length === 0) { grid.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-12"><i class="fas fa-wifi-slash text-4xl mb-3 block"></i>No ESP32-Sync players discovered yet.</div>'; return; }
                grid.innerHTML = syncPlayers.map(p => {
                    const c = { playing: 'green', paused: 'yellow', idle: 'gray' }[p.playback_state || 'idle'] || 'gray';
                    return '<div class="glass rounded-2xl p-5 shadow-xl border border-white/10"><div class="flex items-center justify-between mb-4"><div class="flex items-center gap-3"><div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/30 to-purple-500/30 flex items-center justify-center"><i class="fas ' + (p.is_group ? 'fa-layer-group' : 'fa-speaker') + ' text-blue-400"></i></div><div><h3 class="font-bold">' + p.name + '</h3><p class="text-xs text-gray-500">' + p.player_id + '</p></div></div><span class="px-2 py-1 rounded-full text-xs font-medium ' + (p.available ? 'bg-' + c + '-100 text-' + c + '-700' : 'bg-red-100 text-red-700') + '">' + (p.available ? (p.playback_state || 'idle') : 'offline') + '</span></div>' + (p.current_media ? '<div class="text-sm text-gray-600 truncate mb-3"><i class="fas fa-music mr-1 text-primary"></i>' + (p.current_media.title || 'Playing…') + '</div>' : '') + '<div class="flex items-center gap-2 mt-2"><i class="fas fa-volume-up text-gray-400 text-xs"></i><div class="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"><div class="h-full bg-primary rounded-full transition-all" style="width:' + (p.group_volume ?? p.volume_level ?? 0) + '%"></div></div><span class="text-xs text-gray-500 font-mono w-8">' + (p.group_volume ?? p.volume_level ?? 0) + '%</span></div><div class="flex gap-2 mt-4"><button onclick="maDevCmd(\'play_pause\',\'' + p.player_id + '\')" class="flex-1 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium"><i class="fas fa-play mr-1"></i>Play/Pause</button><button onclick="maDevCmd(\'stop\',\'' + p.player_id + '\')" class="flex-1 py-1.5 rounded-lg bg-red-100 hover:bg-red-200 text-red-600 text-xs font-medium"><i class="fas fa-stop mr-1"></i>Stop</button></div></div>';
                }).join('');
            });
        }
        window.maDevCmd = function(cmd, playerId) {
            fetch('/api/ma/' + cmd, { method: 'POST', body: new FormData().append('player_id', playerId) }).then(() => setTimeout(loadMAPlayers, 500));
        };
        loadMAPlayers();
        window._devicesRefreshInterval = setInterval(loadMAPlayers, 5000);
    }

    let _schedulerRefreshInterval = null;

    function initScheduler() {
        loadSchedules();
        initCalendar();
        const form = document.getElementById('schedulerForm');
        if (form) form.addEventListener('submit', e => { e.preventDefault(); submitSchedule(); });
        loadSchedulerDevices();
        
        // Start auto-refresh for calendar and schedule table every 30 seconds
        if (_schedulerRefreshInterval) clearInterval(_schedulerRefreshInterval);
        _schedulerRefreshInterval = setInterval(() => {
            loadSchedules();
            // Refresh calendar events if calendar instance exists
            if (window._calendarInstance) {
                window._calendarInstance.refetchEvents();
            }
            console.log('[Scheduler] Auto-refreshed schedules');
        }, 30000);
    }

    window.setSchedRepeat = function(mode) {
        const rs = document.getElementById('repeatSelect');
        if (rs) rs.value = mode;
        ['none', 'daily', 'weekly', 'monthly'].forEach(m => {
            const btn = document.getElementById('btnRepeat_' + m);
            if (btn) btn.className = 'flex-1 py-1.5 rounded-full text-xs font-medium ' + (m === mode ? 'bg-primary text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600');
        });
    };

    function loadSchedulerDevices() {
        const container = document.getElementById('targetDeviceContainer');
        if (!container) return;
        fetch('/api/ma/players').then(r => r.json()).then(players => {
            const groupPlayer = players.find(p => p.is_group && p.in_sync_group);
            const groupMembers = groupPlayer ? players.filter(p => p.in_sync_group && !p.is_group) : [];
            let html = '';
            if (groupPlayer) html += '<label class="flex items-center space-x-3 cursor-pointer p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded mb-2 border border-green-200 dark:border-green-800"><input type="radio" name="targetDevice" value="' + groupPlayer.player_id + '" class="text-primary h-4 w-4" checked><i class="fas fa-layer-group text-blue-500"></i><span class="text-sm font-medium">' + groupPlayer.name + ' (Group)</span></label>';
            if (groupMembers.length > 0) {
                html += '<div class="text-xs text-gray-500 px-1 mb-1 mt-2">Individual Speakers:</div>';
                html += groupMembers.map(p => '<label class="flex items-center space-x-3 cursor-pointer p-2 hover:bg-gray-200 rounded mb-1 ' + (p.available ? '' : 'opacity-50') + '"><input type="radio" name="targetDevice" value="' + p.player_id + '" class="text-primary h-4 w-4"><i class="fas fa-volume-up text-gray-400"></i><span class="text-sm">' + p.name + '</span></label>').join('');
            }
            if (!groupPlayer && groupMembers.length === 0) html = '<label class="flex items-center space-x-3 cursor-pointer p-1 hover:bg-gray-200 rounded"><input type="radio" name="targetDevice" value="all" class="text-primary h-4 w-4" checked><span class="text-sm font-medium">All ESP32-Sync (Group)</span></label>';
            container.innerHTML = html;
        }).catch(() => { container.innerHTML = '<label class="flex items-center space-x-3 cursor-pointer p-1"><input type="radio" name="targetDevice" value="all" class="text-primary h-4 w-4" checked><span class="text-sm font-medium">All ESP32-Sync</span></label>'; });
    }

    function loadSchedules() {
        fetch('/api/schedules').then(r => r.json()).then(schedules => {
            const tbody = document.getElementById('scheduleTableBody');
            if (!tbody) return;
            if (schedules.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-500">No schedules yet.</td></tr>'; return; }
            tbody.innerHTML = schedules.map(s => '<tr class="border-b hover:bg-gray-50 dark:hover:bg-gray-800/30"><td class="py-3 px-4 text-sm">' + new Date(s.play_time).toLocaleString() + '</td><td class="py-3 px-4 text-sm font-medium truncate max-w-[200px]">' + s.audio_name + '</td><td class="py-3 px-4 text-sm text-gray-500">' + s.device_name + '</td><td class="py-3 px-4"><span class="px-2 py-1 text-xs rounded-full ' + (s.repeat !== 'none' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500') + '">' + s.repeat + '</span></td><td class="py-3 px-4 text-right"><button onclick="window.openScheduleModal(' + s.id + ',' + JSON.stringify(s).replace(/"/g, '&quot;') + ')" class="text-primary hover:text-blue-700 text-xs mr-2"><i class="fas fa-edit"></i></button><button onclick="deleteSchedule(' + s.id + ')" class="text-red-400 hover:text-red-600 text-xs"><i class="fas fa-trash"></i></button></td></tr>').join('');
        });
    }

    window.openScheduleModal = function(id, data) {
        const modal = document.getElementById('scheduleModal');
        const titleEl = document.getElementById('modalTitle');
        const editIdEl = document.getElementById('editingScheduleId');
        if (!modal) return;
        fetch('/api/files').then(r => r.json()).then(files => { window.allFiles = files; const sel = document.getElementById('audioSelect'); if (sel) sel.innerHTML = files.map(f => '<option value="' + f.id + '">' + f.original_name + '</option>').join(''); });
        loadSchedulerDevices();
        if (id && data) {
            if (titleEl) titleEl.textContent = 'Edit Schedule';
            if (editIdEl) editIdEl.value = id;
            const dt = new Date(data.play_time);
            const de = document.getElementById('dateSelect');
            if (de) de.value = dt.toISOString().slice(0, 10);
            const te = document.getElementById('timeSelect');
            if (te) { te.value = dt.toTimeString().slice(0, 8); const td = document.getElementById('timeDisplay'); if (td) td.textContent = te.value; }
            const ve = document.getElementById('scheduleVolumeSelect');
            if (ve) ve.value = data.volume;
            const vv = document.getElementById('schedVolVal');
            if (vv) vv.textContent = data.volume;
            window.setSchedRepeat(data.repeat || 'none');
        } else {
            if (titleEl) titleEl.textContent = 'Add Schedule';
            if (editIdEl) editIdEl.value = '';
            const de = document.getElementById('dateSelect');
            if (de) de.value = new Date().toISOString().slice(0, 10);
        }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    };

    window.closeScheduleModal = function() { const modal = document.getElementById('scheduleModal'); if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };

    function submitSchedule() {
        const editingId = document.getElementById('editingScheduleId')?.value;
        const date = document.getElementById('dateSelect')?.value;
        const time = document.getElementById('timeSelect')?.value || '12:00:00';
        const audioId = document.getElementById('audioSelect')?.value;
        const volume = document.getElementById('scheduleVolumeSelect')?.value || 70;
        const repeat = document.getElementById('repeatSelect')?.value || 'none';
        const deviceName = document.querySelector('input[name="targetDevice"]:checked')?.value || 'all';
        if (!date || !audioId) { Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'Please fill all fields', showConfirmButton: false, timer: 2000 }); return; }
        const payload = { device_name: deviceName, audio_id: parseInt(audioId), play_time: date + 'T' + time, repeat, volume: parseInt(volume) };
        const url = editingId ? '/api/schedules/' + editingId : '/api/schedules';
        const method = editingId ? 'PUT' : 'POST';
        fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()).then(() => { window.closeScheduleModal(); loadSchedules(); Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: editingId ? 'Schedule updated' : 'Schedule added', showConfirmButton: false, timer: 2000 }); }).catch(() => Swal.fire('Error', 'Failed to save schedule', 'error'));
    }

    window.deleteSchedule = function(id) {
        Swal.fire({ title: 'Delete schedule?', icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', confirmButtonText: 'Delete' }).then(r => { 
            if (r.isConfirmed) {
                fetch('/api/schedules/' + id, { method: 'DELETE' }).then(() => { 
                    loadSchedules(); 
                    // Also update FullCalendar
                    if (window._calendarInstance) {
                        const event = window._calendarInstance.getEventById(id);
                        if (event) event.remove();
                    }
                }); 
            }
        });
    };

    function initCalendar() {
        const calEl = document.getElementById('calendar');
        if (!calEl || typeof FullCalendar === 'undefined') return;
        const cal = new FullCalendar.Calendar(calEl, {
            initialView: 'dayGridMonth',
            headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,listWeek' },
            events(info, success) {
                fetch('/api/schedules').then(r => r.json()).then(scheds => {
                    const events = [];
                    scheds.forEach(s => {
                        const dt = new Date(s.play_time);
                        const timeStr = dt.toTimeString().slice(0,8);
                        const title = timeStr + ' > ' + (s.device_name || 'All') + ' > ' + s.audio_name;
                        const color = s.repeat === 'weekly' ? '#8b5cf6' : (s.repeat === 'monthly' ? '#f59e0b' : (s.repeat === 'daily' ? '#10b981' : '#3b82f6'));
                        const evt = {
                            id: s.id,
                            title: title,
                            start: s.play_time,
                            color: color,
                            extendedProps: { repeat: s.repeat }
                        };
                        // Generate recurring events using rrule properties
                        // (@fullcalendar/rrule plugin is loaded in base.html)
                        if (s.repeat === 'daily') {
                            evt.rrule = { freq: 'daily', dtstart: s.play_time };
                            evt.duration = '00:05:00';
                            delete evt.start;
                        } else if (s.repeat === 'weekly') {
                            evt.rrule = { freq: 'weekly', dtstart: s.play_time, byweekday: [['su','mo','tu','we','th','fr','sa'][dt.getDay()]] };
                            evt.duration = '00:05:00';
                            delete evt.start;
                        } else if (s.repeat === 'monthly') {
                            evt.rrule = { freq: 'monthly', dtstart: s.play_time, bymonthday: [dt.getDate()] };
                            evt.duration = '00:05:00';
                            delete evt.start;
                        }
                        events.push(evt);
                    });
                    success(events);
                });
            },
            eventClick: info => window.openScheduleModal(info.event.id, null),
            dateClick: info => { window.openScheduleModal(null, null); setTimeout(() => { const de = document.getElementById('dateSelect'); if (de) de.value = info.dateStr; }, 100); },
            eventContent: arg => {
                const icon = { none: 'fa-calendar', daily: 'fa-calendar-day', weekly: 'fa-calendar-week', monthly: 'fa-calendar-alt' }[arg.event.extendedProps?.repeat || 'none'] || 'fa-calendar';
                return { html: '<div class="fc-event-text-wrap"><i class="fas ' + icon + ' mr-1"></i>' + arg.event.title + '</div>' };
            }
        });
        cal.render();
        window._calendarInstance = cal;
    }

    function initConfig() {
        fetch('/api/config').then(r => r.json()).then(conf => {
            if (!conf) return;
            const vol = document.getElementById('cfgVol');
            const volVal = document.getElementById('cfgVolVal');
            if (vol) { vol.value = conf.default_volume || 50; if (volVal) volVal.textContent = (conf.default_volume || 50) + '%'; vol.addEventListener('input', e => { if (volVal) volVal.textContent = e.target.value + '%'; }); }
            const tz = document.getElementById('cfgTz');
            if (tz) tz.value = conf.timezone || 'Asia/Jayapura';
            const lang = document.getElementById('cfgLang');
            if (lang) lang.value = conf.language || 'en';
            const tcEnable = document.getElementById('cfgTcEnable');
            const tcOpts = document.getElementById('cfgTcOptions');
            if (tcEnable) { tcEnable.checked = conf.transcode_enabled; if (tcOpts) tcOpts.classList.toggle('hidden', !conf.transcode_enabled); tcEnable.addEventListener('change', e => { if (tcOpts) tcOpts.classList.toggle('hidden', !e.target.checked); updateTranscodeFormats(); }); }
            const tcType = document.getElementById('cfgTcType');
            if (tcType) { tcType.value = conf.transcode_type || 'lossy'; tcType.addEventListener('change', updateTranscodeFormats); }
            const tcFmt = document.getElementById('cfgTcFormat');
            const tcBit = document.getElementById('cfgTcBitrate');
            const tcRate = document.getElementById('cfgTcSampleRate');
            if (tcRate) tcRate.value = conf.transcode_samplerate || '44100';
            function updateTranscodeFormats() {
                const type = document.getElementById('cfgTcType')?.value;
                if (tcFmt) {
                    if (type === 'lossy') { tcFmt.innerHTML = '<option value="mp3">MP3</option><option value="aac">AAC</option><option value="ogg">OGG Vorbis</option>'; if (tcBit) tcBit.innerHTML = '<option value="64k">64 kbps</option><option value="96k">96 kbps</option><option value="128k">128 kbps</option><option value="192k">192 kbps</option><option value="320k">320 kbps</option>'; }
                    else { tcFmt.innerHTML = '<option value="flac">FLAC</option><option value="wav">WAV</option>'; if (tcBit) tcBit.innerHTML = '<option value="16bit">16-bit</option><option value="24bit">24-bit</option>'; }
                    tcFmt.value = conf.transcode_format || (type === 'lossy' ? 'mp3' : 'flac');
                    if (tcBit) tcBit.value = conf.transcode_bitrate || (type === 'lossy' ? '128k' : '16bit');
                }
            }
            updateTranscodeFormats();
        });
        const form = document.getElementById('configForm');
        if (form) form.addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(form); const tcEnable = document.getElementById('cfgTcEnable'); fd.set('transcode_enabled', tcEnable?.checked ? 'true' : 'false'); await fetch('/api/config', { method: 'POST', body: fd }); Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Settings saved', showConfirmButton: false, timer: 2000 }); });
        fetch('/api/ma/status').then(r => r.json()).then(st => {
            const maUrl = document.getElementById('cfgMaUrl');
            const maGroup = document.getElementById('cfgMaGroup');
            const maConn = document.getElementById('cfgMaConn');
            if (maUrl) maUrl.textContent = st.ma_url;
            if (maGroup) maGroup.textContent = st.group_player_name + (st.group_player_id ? ' (' + st.group_player_id + ')' : '');
            if (maConn) maConn.innerHTML = st.connected ? '<span class="text-green-500"><i class="fas fa-check-circle mr-1"></i>Connected</span>' : '<span class="text-red-400"><i class="fas fa-times-circle mr-1"></i>Disconnected</span>';
        }).catch(() => {});
    }

    window.initPageScripts = function(url) {
        // Clean up all polling intervals when navigating
        if (window._devicesRefreshInterval && url !== '/devices') { 
            clearInterval(window._devicesRefreshInterval); 
            window._devicesRefreshInterval = null; 
        }
        // Clean up dashboard polling intervals
        if (_playlistRefreshInterval && url !== '/' && url !== '') { 
            clearInterval(_playlistRefreshInterval); 
            _playlistRefreshInterval = null; 
        }
        if (_playerStatePollInterval && url !== '/' && url !== '') { 
            clearInterval(_playerStatePollInterval); 
            _playerStatePollInterval = null; 
        }
        // Clean up scheduler polling interval
        if (_schedulerRefreshInterval && url !== '/scheduler') { 
            clearInterval(_schedulerRefreshInterval); 
            _schedulerRefreshInterval = null; 
        }
        // Reset playback state tracking so WaveSurfer can re-trigger play on page changes
        _lastKnownPlaybackState = null;
        if (url === '/' || url === '') initDashboard();
        else if (url === '/devices') initDevices();
        else if (url === '/scheduler') initScheduler();
        else if (url === '/config') initConfig();
        // Also bind bottom player controls on any page
        bindBottomPlayerControls();
    };

    // ─── Sendspin Client Integration ──────────────────────────────────────────
    function initSendspinClient() {
        const SendspinLib = typeof SendspinJS !== 'undefined' ? SendspinJS : (typeof SendspinClient !== 'undefined' ? SendspinClient : null);
        if (!SendspinLib) { console.warn('[Sendspin] Library not loaded, sync disabled'); return; }
        try {
            let storedPlayerId = localStorage.getItem('sendspin_player_id');
            if (!storedPlayerId) { storedPlayerId = 'webapp-' + Math.random().toString(36).substr(2, 9); localStorage.setItem('sendspin_player_id', storedPlayerId); }
            const PlayerClass = SendspinLib.SendspinPlayer || SendspinLib;
            window.sendspinPlayer = new PlayerClass({
                playerId: storedPlayerId,
                clientName: 'Audio-Auto Web',
                baseUrl: location.protocol === 'https:' ? 'wss://' + location.hostname + ':8927' : 'ws://' + location.hostname + ':8927',
                onStateChange: (state) => { console.log('[Sendspin] State:', state); }
            });
            window.sendspinPlayer.connect().catch(e => console.warn('[Sendspin] Connect failed:', e.message));
            console.log('[Sendspin] Player initialized:', storedPlayerId);
        } catch (e) { console.warn('[Sendspin] Init failed:', e.message); }
    }

    // ─── Kick off ─────────────────────────────────────────────────────────────
    connectWebSocket();
    window.initPageScripts(location.pathname);
    setTimeout(initSendspinClient, 1000);

}); // DOMContentLoaded
