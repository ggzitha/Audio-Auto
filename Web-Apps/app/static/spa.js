// app/static/spa.js
// Audio-Auto — Music Assistant Edition
// All playback is controlled via /api/ma/* which proxies to Music Assistant.
// Real-time state comes from MA WebSocket events forwarded by our /ws endpoint.

document.addEventListener('DOMContentLoaded', () => {

    // ─── Global MA State ───────────────────────────────────────────────────────
    window.maState = {
        players: {},           // player_id → player object (from MA)
        groupPlayerId: null,   // resolved group player_id ("ESP32-Sync")
        selectedPlayerId: null,// currently selected player
        connected: false,      // MA WS connected?
    };

    window.allFiles  = [];
    window.playQueue = [];     // local file order (for next/prev)

    // ─── Element references ────────────────────────────────────────────────────
    const bottomPlayer = document.getElementById('bottom-player');
    const miniSongTitle = document.getElementById('miniSongTitle');
    const miniTimeElapsed = document.getElementById('miniTimeElapsed');
    const miniTimeTotal   = document.getElementById('miniTimeTotal');
    const miniProgressOverlay = document.getElementById('miniProgressOverlay');
    const miniVolSlider  = document.getElementById('miniVolSlider');
    const miniPlayIcon   = document.getElementById('miniPlayIcon');
    const miniBtnPlay    = document.getElementById('miniBtnPlay');
    const miniBtnNext    = document.getElementById('miniBtnNext');
    const miniBtnPrev    = document.getElementById('miniBtnPrev');

    // ─── WaveSurfer (Visual + Audio Output) ───────────────────────────────────
    let wavesurfer = null;
    let wavesurferInitialized = false;
    let currentLoadedFileId   = null;
    let globalWaveformContainer = document.createElement('div');
    globalWaveformContainer.id = 'persistentWaveform';

    // ─── SPA Routing ──────────────────────────────────────────────────────────
    const mainContent = document.getElementById('spa-content');

    function updatePlayerVisibility(url) {
        if (!bottomPlayer) return;
        if (url === '/' || url === '') {
            bottomPlayer.classList.add('hidden');
        } else {
            const playing = Object.values(window.maState.players).some(
                p => p.playback_state === 'playing' || p.playback_state === 'paused'
            );
            if (playing) bottomPlayer.classList.remove('hidden');
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
                const parser  = new DOMParser();
                const doc     = parser.parseFromString(html, 'text/html');
                const newContent = doc.getElementById('spa-content');
                if (newContent && mainContent) {
                    mainContent.innerHTML = newContent.innerHTML;
                    mainContent.querySelectorAll('script').forEach(oldScript => {
                        const newScript = document.createElement('script');
                        if (oldScript.src) {
                            newScript.src = oldScript.src;
                        } else {
                            newScript.textContent = oldScript.textContent;
                        }
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

    // ─── WebSocket (our /ws — relays MA events) ───────────────────────────────
    let ws = null;
    let wsReconnectTimer = null;

    function connectWebSocket() {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}/ws`);

        ws.onopen = () => {
            console.log('[WS] Connected');
            const st = document.getElementById('infoWsStatus');
            if (st) { st.textContent = 'Connected'; st.className = 'text-xs font-semibold text-green-500'; }
        };

        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                handleWsMessage(msg);
            } catch (e) {
                console.error('[WS] Parse error:', e);
            }
        };

        ws.onclose = () => {
            wsReconnectTimer = setTimeout(connectWebSocket, 3000);
        };
        ws.onerror = () => ws.close();
    }

    function handleWsMessage(msg) {
        const t = msg.type;

        if (t === 'ma_players_snapshot') {
            // Initial snapshot on WS connect
            if (Array.isArray(msg.players)) {
                msg.players.forEach(p => {
                    window.maState.players[p.player_id] = p;
                });
                _resolveGroupPlayer();
                updateUIFromMA();
            }

        } else if (t === 'ma_player') {
            const p = msg.player;
            if (!p || !p.player_id) return;
            window.maState.players[p.player_id] = p;
            if (msg.event === 'player_removed') {
                delete window.maState.players[p.player_id];
            }
            _resolveGroupPlayer();
            updateUIFromMA();

        } else if (t === 'ma_queue_time') {
            // High-frequency position update
            const d = msg.data || {};
            const qid = d.queue_id;
            if (!qid) return;
            // Find player matching this queue_id and update elapsed time
            const activePlayer = getActivePlayer();
            if (activePlayer && (activePlayer.player_id === qid || activePlayer.current_queue_id === qid)) {
                activePlayer.elapsed_time = d.elapsed_time;
                activePlayer.elapsed_time_last_updated = d.elapsed_time_last_updated || (Date.now() / 1000);
            }
            _updateProgressBar();

        } else if (t === 'transcode_progress') {
            if (msg.status === 'started') {
                Swal.fire({
                    title: 'Transcoding Audio',
                    html: `<div class="text-sm mb-4">Processing <b>${msg.file}</b>...</div><div class="flex justify-center"><i class="fas fa-cog fa-spin text-4xl text-primary"></i></div>`,
                    allowOutsideClick: false,
                    showConfirmButton: false,
                    customClass: { popup: 'glass' },
                });
            } else if (msg.status === 'done') {
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Transcoding complete', text: msg.file, showConfirmButton: false, timer: 3000 });
                fetch('/api/files').then(r => r.json()).then(files => {
                    window.allFiles = files;
                    const pc = document.getElementById('playlistContainer');
                    if (pc) renderPlaylist(files);
                });
            } else if (msg.status === 'error') {
                Swal.fire('Transcode Failed', `Failed to transcode ${msg.file}`, 'error');
            }
        }
    }

    function _resolveGroupPlayer() {
        const cached = Object.values(window.maState.players).find(p =>
            (p.is_group || p.type === 'group') &&
            (p.player_id === window.maState.groupPlayerId ||
             p.in_sync_group ||
             (p.name || '').toLowerCase().includes('esp32'))
        );
        if (cached) {
            window.maState.groupPlayerId = cached.player_id;
            if (!window.maState.selectedPlayerId) {
                window.maState.selectedPlayerId = cached.player_id;
            }
        }
    }

    // ─── Helper: get current active player ────────────────────────────────────
    function getActivePlayer() {
        const pid = window.maState.selectedPlayerId || window.maState.groupPlayerId;
        return pid ? (window.maState.players[pid] || null) : null;
    }

    function getSelectedPlayerId() {
        return window.maState.selectedPlayerId || window.maState.groupPlayerId || 'ESP32-Sync';
    }

    // ─── UI update from MA state ───────────────────────────────────────────────
    function updateUIFromMA() {
        const player = getActivePlayer();
        if (!player) return;

        const isPlaying = player.playback_state === 'playing';
        const isPaused  = player.playback_state === 'paused';
        const media     = player.current_media;

        // Song title from MA current_media
        let title = 'Ready';
        let artist = 'Audio-Auto → Music Assistant';
        if (media) {
            title  = media.title || _filenameToTitle(media.uri || '') || 'Playing…';
            artist = media.artist || (isPlaying ? 'Playing via MA' : 'Paused');
        }

        if (miniSongTitle) miniSongTitle.textContent = title;
        if (miniPlayIcon) {
            miniPlayIcon.className = isPlaying
                ? 'fas fa-pause-circle text-2xl md:text-3xl'
                : 'fas fa-play-circle text-2xl md:text-3xl';
        }

        // Big player on dashboard
        const bigTitle = document.getElementById('nowPlaying');
        if (bigTitle) bigTitle.textContent = title;
        const bigArtist = document.getElementById('nowPlayingArtist');
        if (bigArtist) bigArtist.textContent = artist;

        const bigPlayIcon = document.getElementById('playIcon');
        if (bigPlayIcon) {
            bigPlayIcon.className = isPlaying
                ? 'fas fa-pause-circle text-5xl md:text-6xl drop-shadow-md'
                : 'fas fa-play-circle text-5xl md:text-6xl drop-shadow-md';
        }

        // Volume
        const vol = player.group_volume ?? player.volume_level ?? 50;
        const volSlider = document.getElementById('volSlider');
        if (volSlider && document.activeElement !== volSlider) volSlider.value = vol;
        if (miniVolSlider && document.activeElement !== miniVolSlider) miniVolSlider.value = vol;

        // WaveSurfer: load audio if track changed
        if (media && media.uri) {
            // Try to match MA URI to a local file
            const matchedFile = _matchUriToFile(media.uri);
            if (matchedFile && matchedFile.id !== currentLoadedFileId && wavesurfer) {
                currentLoadedFileId = matchedFile.id;
                const src = `/audio_files/${encodeURIComponent(matchedFile.filename)}`;
                wavesurfer.load(src).then(() => {
                    const ap = getActivePlayer();
                    if (ap && ap.playback_state === 'playing') wavesurfer.play();
                }).catch(e => { if (e.name !== 'AbortError') console.warn(e); });
                // Highlight in playlist
                _highlightPlaylist(matchedFile.id);
            }
            // Duration from media
            if (media.duration && miniTimeTotal) {
                miniTimeTotal.textContent = formatTime(media.duration);
                const timeTotal = document.getElementById('timeTotal');
                if (timeTotal) timeTotal.textContent = formatTime(media.duration);
            }
        }

        // Sync local playback state
        if (wavesurfer && currentLoadedFileId) {
            if (isPlaying && !wavesurfer.isPlaying()) {
                wavesurfer.play().catch(e => console.warn('Browser autoplay prevented:', e));
            } else if (!isPlaying && wavesurfer.isPlaying()) {
                wavesurfer.pause();
            }
        }

        // Mini-player bar visibility
        if ((isPlaying || isPaused) && location.pathname !== '/') {
            if (bottomPlayer) bottomPlayer.classList.remove('hidden');
        }

        // MA status panel
        _updateMaStatusPanel();
    }

    function _updateProgressBar() {
        const player = getActivePlayer();
        if (!player) return;
        let elapsed = player.elapsed_time || 0;
        const lastUpd = player.elapsed_time_last_updated || 0;
        if (player.playback_state === 'playing' && lastUpd > 0) {
            elapsed += (Date.now() / 1000) - lastUpd;
        }

        const dur = (player.current_media && player.current_media.duration) || 0;

        if (miniTimeElapsed) miniTimeElapsed.textContent = formatTime(elapsed);
        const timeElapsed = document.getElementById('timeElapsed');
        if (timeElapsed) timeElapsed.textContent = formatTime(elapsed);

        if (dur > 0) {
            const pct = Math.min((elapsed / dur) * 100, 100);
            if (miniProgressOverlay) miniProgressOverlay.style.width = pct + '%';
            // WaveSurfer visual & audio position sync
            if (wavesurfer && wavesurfer.getDuration() > 0) {
                const wsTime = wavesurfer.getCurrentTime();
                if (Math.abs(wsTime - elapsed) > 0.5) {
                    wavesurfer.seekTo(elapsed / wavesurfer.getDuration());
                }
            }
        }
    }

    // Live progress ticker
    setInterval(_updateProgressBar, 250);

    function _updateMaStatusPanel() {
        const panel = document.getElementById('maStatusPanel');
        if (!panel) return;
        const players = Object.values(window.maState.players);
        if (players.length === 0) {
            panel.innerHTML = '<div class="text-sm text-gray-500 text-center py-4">No MA players discovered yet…</div>';
            return;
        }
        panel.innerHTML = players
            .filter(p => p.in_sync_group || p.is_group)
            .map(p => {
                const state = p.playback_state || 'idle';
                const vol   = p.group_volume ?? p.volume_level ?? '?';
                const stateColors = {
                    playing: 'text-green-500',
                    paused:  'text-yellow-500',
                    idle:    'text-gray-400',
                    unknown: 'text-gray-400',
                };
                const stateIcons = {
                    playing: 'fa-play',
                    paused:  'fa-pause',
                    idle:    'fa-stop',
                    unknown: 'fa-question',
                };
                const color = stateColors[state] || 'text-gray-400';
                const icon  = stateIcons[state]  || 'fa-question';
                return `
                    <div class="flex justify-between items-center p-2 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 mb-2">
                        <div class="flex items-center gap-2">
                            <i class="fas ${icon} ${color} text-sm w-4 text-center"></i>
                            <span class="font-medium text-sm">${p.name || p.player_id}</span>
                            ${p.is_group ? '<span class="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">Group</span>' : ''}
                        </div>
                        <div class="flex items-center gap-3 text-xs font-mono">
                            <span class="${color}">${state}</span>
                            <span class="text-gray-500"><i class="fas fa-volume-up mr-1"></i>${vol}%</span>
                        </div>
                    </div>
                `;
            }).join('') || '<div class="text-sm text-gray-500 text-center py-4">No ESP32-Sync players visible.</div>';
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function _filenameToTitle(uri) {
        const parts = uri.split('/');
        return decodeURIComponent(parts[parts.length - 1] || '').replace(/\.[^.]+$/, '');
    }

    function _matchUriToFile(uri) {
        // Try to find local file whose filename appears in the URI
        return window.allFiles.find(f => uri.includes(encodeURIComponent(f.filename)) || uri.includes(f.filename));
    }

    function _highlightPlaylist(fileId) {
        document.querySelectorAll('#playlistContainer > div').forEach(el => {
            el.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
        });
        const active = document.querySelector(`#playlistContainer > div[data-id="${fileId}"]`);
        if (active) active.classList.add('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
    }

    // ─── API wrappers ──────────────────────────────────────────────────────────
    async function maPost(path, fields) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const resp = await fetch('/api/ma/' + path, { method: 'POST', body: fd });
        if (!resp.ok) {
            const txt = await resp.text();
            console.warn(`[MA] ${path} failed:`, txt);
        }
        return resp;
    }

    // Get the actual MA player_id (not display name)
    function pid() { 
        const selected = window.maState.selectedPlayerId;
        const group = window.maState.groupPlayerId;
        
        // If selected player is in our players cache, return the actual MA player_id
        if (selected && window.maState.players[selected]) {
            return selected;
        }
        // If group player is in cache, return it
        if (group && window.maState.players[group]) {
            return group;
        }
        // Fallback - prefer actual player_id from cache over display names
        const cachedIds = Object.keys(window.maState.players);
        if (cachedIds.length > 0) {
            // Prefer group player if available
            const groupPlayer = cachedIds.find(id => window.maState.players[id]?.is_group);
            if (groupPlayer) return groupPlayer;
            return cachedIds[0];
        }
        // Last resort
        return selected || group || 'ESP32-Sync';
    }

    // ─── Playback controls ─────────────────────────────────────────────────────
    window.selectSong = function(id) {
        const file = window.allFiles.find(f => f.id === id);
        if (!file) return;

        // Load waveform visual
        if (wavesurfer) {
            currentLoadedFileId = id;
            wavesurfer.load(`/audio_files/${encodeURIComponent(file.filename)}`).catch(e => {
                if (e.name !== 'AbortError') console.warn(e);
            });
        }
        _highlightPlaylist(id);

        maPost('play', { player_id: pid(), audio_id: id });
    };

    function togglePlay() {
        const player = getActivePlayer();
        if (!player) {
            // Nothing selected yet — play first file
            if (window.allFiles.length > 0) window.selectSong(window.allFiles[0].id);
            return;
        }
        maPost('play_pause', { player_id: pid() });
    }

    function stopPlayback() {
        maPost('stop', { player_id: pid() });
        if (wavesurfer) wavesurfer.seekTo(0);
    }

    function playNext() {
        const player = getActivePlayer();
        const media  = player && player.current_media;
        if (media) {
            // Try MA next command first
            maPost('next', { player_id: pid() });
            return;
        }
        // Fall back to local file list
        if (window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => _matchUriToFile(media?.uri || '') === f);
        idx = (idx + 1) % window.allFiles.length;
        window.selectSong(window.allFiles[idx].id);
    }

    function playPrev() {
        const player = getActivePlayer();
        const media  = player && player.current_media;
        if (media) {
            maPost('prev', { player_id: pid() });
            return;
        }
        if (window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => _matchUriToFile(media?.uri || '') === f);
        idx = (idx - 1 + window.allFiles.length) % window.allFiles.length;
        window.selectSong(window.allFiles[idx].id);
    }

    function setVolume(vol) {
        maPost('volume', { player_id: pid(), volume: Math.round(vol) });
    }

    function seekTo(position) {
        maPost('seek', { player_id: pid(), position });
    }

    // ─── Device (player) selection ─────────────────────────────────────────────
    window.openDeviceModal = function() {
        const modal   = document.getElementById('deviceModal');
        const content = document.getElementById('deviceModalContent');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => {
            if (content) content.classList.remove('scale-95', 'opacity-0'), content.classList.add('scale-100', 'opacity-100');
        }, 10);
        window.renderDeviceModalList();
    };

    window.closeDeviceModal = function() {
        const modal   = document.getElementById('deviceModal');
        const content = document.getElementById('deviceModalContent');
        if (!modal) return;
        if (content) { content.classList.remove('scale-100', 'opacity-100'); content.classList.add('scale-95', 'opacity-0'); }
        setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 300);
    };

    window.renderDeviceModalList = function() {
        const list = document.getElementById('deviceModalList');
        if (!list) return;

        fetch('/api/ma/players')
            .then(r => r.json())
            .then(players => {
                // Find the group player
                const groupPlayer = players.find(p => p.is_group && p.in_sync_group);
                const groupMembers = groupPlayer ? players.filter(p => p.in_sync_group && !p.is_group) : [];
                
                // Build the list: Group at top, then individual members
                let html = '';
                
                // Group player option
                if (groupPlayer) {
                    const selected = window.maState.selectedPlayerId === groupPlayer.player_id;
                    const avail = groupPlayer.available;
                    const state = groupPlayer.playback_state || 'idle';
                    const stateIcons = { playing: '▶', paused: '⏸', idle: '■', unknown: '?' };
                    html += `
                        <div onclick="window.selectMAPlayer('${groupPlayer.player_id}')"
                             class="flex items-center justify-between p-3 rounded-lg border ${selected ? 'border-primary bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'} cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors mb-2">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-full flex items-center justify-center ${avail ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}">
                                    <i class="fas fa-layer-group text-xs"></i>
                                </div>
                                <div>
                                    <h4 class="font-semibold text-sm text-gray-800 dark:text-gray-200">${groupPlayer.name} (Group)</h4>
                                    <p class="text-xs text-gray-500">${avail ? stateIcons[state] + ' ' + state : 'Offline'} · All speakers</p>
                                </div>
                            </div>
                            <i class="fas ${selected ? 'fa-check-circle text-primary text-lg' : 'fa-circle text-gray-300 dark:text-gray-600'}"></i>
                        </div>
                    `;
                }
                
                // Individual player options
                if (groupMembers.length > 0) {
                    html += '<div class="text-xs text-gray-500 px-1 mb-1">Individual Speakers:</div>';
                    html += groupMembers.map(p => {
                        const selected = window.maState.selectedPlayerId === p.player_id;
                        const avail = p.available;
                        const state = p.playback_state || 'idle';
                        const stateIcons = { playing: '▶', paused: '⏸', idle: '■', unknown: '?' };
                        return `
                            <div onclick="window.selectMAPlayer('${p.player_id}')"
                                 class="flex items-center justify-between p-3 rounded-lg border ${selected ? 'border-primary bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'} cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors mb-1">
                                <div class="flex items-center gap-3">
                                    <div class="w-8 h-8 rounded-full flex items-center justify-center ${avail ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}">
                                        <i class="fas fa-speaker text-xs"></i>
                                    </div>
                                    <div>
                                        <h4 class="font-semibold text-sm text-gray-800 dark:text-gray-200">${p.name}</h4>
                                        <p class="text-xs text-gray-500">${avail ? stateIcons[state] + ' ' + state : 'Offline'}</p>
                                    </div>
                                </div>
                                <i class="fas ${selected ? 'fa-check-circle text-primary text-lg' : 'fa-circle text-gray-300 dark:text-gray-600'}"></i>
                            </div>
                        `;
                    }).join('');
                }
                
                if (!groupPlayer && groupMembers.length === 0) {
                    list.innerHTML = '<div class="text-center text-sm text-gray-500 py-4">No ESP32-Sync players discovered yet.</div>';
                    return;
                }
                
                list.innerHTML = html;
            })
            .catch(() => {
                list.innerHTML = '<div class="text-center text-sm text-red-500 py-4">Failed to load MA players.</div>';
            });
    };

    window.selectMAPlayer = function(playerId) {
        window.maState.selectedPlayerId = playerId;
        const player = window.maState.players[playerId];
        const text   = document.getElementById('selectedDeviceText');
        if (text && player) text.textContent = player.name || playerId;
        const infoSel = document.getElementById('infoSelectedPlayer');
        if (infoSel) infoSel.textContent = (player && player.name) || playerId;
        window.renderDeviceModalList();
    };

    window.applyDeviceSelection = function() {
        window.closeDeviceModal();
    };

    window.setMAQueueMode = function(mode) {
        // mode: 'off' | 'one' | 'all'
        const qid = getSelectedPlayerId(); // queue_id == player_id in MA
        const fd = new FormData();
        fd.append('queue_id', qid);
        fd.append('repeat_mode', mode);
        fetch('/api/ma/repeat', { method: 'POST', body: fd });
    };

    // Stubs for 'Select All' / 'None' buttons in device modal (multi-select not used; just pick group)
    window.selectAllDevices = function() {
        const groupId = window.maState.groupPlayerId;
        if (groupId) window.selectMAPlayer(groupId);
    };
    window.deselectAllDevices = function() { /* no-op in single-select mode */ };

    // ─── Playlist rendering ────────────────────────────────────────────────────
    function renderPlaylist(files) {
        const container = document.getElementById('playlistContainer');
        if (!container) return;
        if (!files || files.length === 0) {
            container.innerHTML = '<div class="p-8 text-center text-gray-500">No files uploaded yet. Click "Upload Music" to add files.</div>';
            return;
        }
        const activePlayer = getActivePlayer();
        const activeUri    = activePlayer?.current_media?.uri || '';

        container.innerHTML = files.map(f => {
            const isActive = activeUri && (activeUri.includes(encodeURIComponent(f.filename)) || activeUri.includes(f.filename));
            const dur      = f.duration_sec ? formatTime(f.duration_sec) : '?:??';
            return `
                <div data-id="${f.id}"
                     class="flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors gap-3 ${isActive ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-primary' : ''}"
                     onclick="window.selectSong(${f.id})">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center shrink-0">
                            <i class="fas fa-music text-blue-400 text-xs"></i>
                        </div>
                        <div class="min-w-0">
                            <p class="font-medium text-gray-800 dark:text-gray-200 truncate text-sm">${f.original_name}</p>
                            <p class="text-xs text-gray-500">${dur}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        ${isActive ? '<i class="fas fa-volume-up text-primary text-sm"></i>' : ''}
                        <button onclick="event.stopPropagation(); deleteFile(${f.id})"
                                class="text-gray-300 hover:text-red-500 transition-colors p-1">
                            <i class="fas fa-trash text-xs"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    window.deleteFile = function(id) {
        Swal.fire({
            title: 'Delete file?',
            text: 'This will also remove any related schedules.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            confirmButtonText: 'Delete',
        }).then(res => {
            if (res.isConfirmed) {
                fetch(`/api/files/${id}`, { method: 'DELETE' })
                    .then(() => {
                        window.allFiles = window.allFiles.filter(f => f.id !== id);
                        renderPlaylist(window.allFiles);
                    });
            }
        });
    };

    // ─── Upload Modal ──────────────────────────────────────────────────────────
    window.openUploadModal = function() {
        Swal.fire({
            title: '<i class="fas fa-cloud-upload-alt mr-2 text-primary"></i>Upload Music',
            html: `
                <div class="text-left space-y-4">
                    <div id="dropZone"
                         class="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-8 text-center cursor-pointer hover:border-primary transition-colors"
                         ondragover="event.preventDefault()" ondrop="handleFileDrop(event)">
                        <i class="fas fa-music text-4xl text-gray-400 mb-3 block"></i>
                        <p class="text-gray-600 dark:text-gray-400 text-sm">Drag & drop audio here or</p>
                        <label class="mt-2 inline-block cursor-pointer text-primary font-semibold hover:underline text-sm">
                            browse files
                            <input type="file" id="uploadFileInput" accept=".mp3,.wav,.flac,.aac,.ogg" class="hidden" onchange="handleFileSelect(event)">
                        </label>
                        <p id="selectedFileName" class="text-xs text-gray-500 mt-2"></p>
                    </div>
                    <div id="uploadProgress" class="hidden">
                        <div class="flex items-center gap-2 text-sm text-primary">
                            <i class="fas fa-spinner fa-spin"></i>
                            <span id="uploadProgressText">Uploading…</span>
                        </div>
                        <div class="w-full h-1 bg-gray-200 rounded-full mt-2">
                            <div id="uploadProgressBar" class="h-1 bg-primary rounded-full transition-all" style="width:0%"></div>
                        </div>
                    </div>
                </div>
            `,
            showConfirmButton: false,
            showCloseButton: true,
            customClass: { popup: 'glass' },
        });

        window._selectedFile = null;
    };

    window.handleFileDrop = function(event) {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) _setUploadFile(file);
    };

    window.handleFileSelect = function(event) {
        const file = event.target.files[0];
        if (file) _setUploadFile(file);
    };

    function _setUploadFile(file) {
        window._selectedFile = file;
        const fn = document.getElementById('selectedFileName');
        if (fn) fn.textContent = file.name;
        // Auto-upload
        _doUpload(file);
    }

    function _doUpload(file) {
        const progress = document.getElementById('uploadProgress');
        const bar      = document.getElementById('uploadProgressBar');
        const txt      = document.getElementById('uploadProgressText');
        if (progress) progress.classList.remove('hidden');
        if (txt) txt.textContent = 'Uploading ' + file.name + '…';

        const fd = new FormData();
        fd.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = e => {
            if (e.lengthComputable && bar) {
                bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
            }
        };
        xhr.onload = () => {
            Swal.close();
            if (xhr.status === 200) {
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Uploaded!', text: file.name, showConfirmButton: false, timer: 3000 });
                fetch('/api/files').then(r => r.json()).then(files => {
                    window.allFiles = files;
                    renderPlaylist(files);
                });
            } else {
                Swal.fire('Upload Failed', xhr.responseText, 'error');
            }
        };
        xhr.onerror = () => Swal.fire('Upload Error', 'Network error during upload.', 'error');
        xhr.send(fd);
    }

    // ─── WaveSurfer initialisation ─────────────────────────────────────────────
    function initWaveSurfer() {
        const container = document.getElementById('waveformContainer');
        if (!container) return;
        if (typeof WaveSurfer === 'undefined') { console.error('WaveSurfer not loaded'); return; }

        container.innerHTML = '';
        container.appendChild(globalWaveformContainer);

        if (wavesurferInitialized) { _attachWaveSurferEvents(); return; }
        wavesurferInitialized = true;

        wavesurfer = WaveSurfer.create({
            container: globalWaveformContainer,
            waveColor: 'rgba(59, 130, 246, 0.4)',
            progressColor: 'rgba(59, 130, 246, 1)',
            barWidth: 2, barGap: 2, barRadius: 2,
            height: 64,
            normalize: true,
            interact: true,
            backend: 'WebAudio',
        });

        wavesurfer.on('interaction', () => {
            const dur = wavesurfer.getDuration();
            if (dur > 0) seekTo(wavesurfer.getCurrentTime());
        });

        wavesurfer.on('ready', () => {
            const dur = wavesurfer.getDuration();
            const timeTotal = document.getElementById('timeTotal');
            if (timeTotal) timeTotal.textContent = formatTime(dur);
            if (miniTimeTotal) miniTimeTotal.textContent = formatTime(dur);
        });

        _attachWaveSurferEvents();
    }

    function _attachWaveSurferEvents() {
        // Progress bar container seek
        const pb = document.getElementById('miniProgressBarContainer');
        if (pb && !pb._seekAttached) {
            pb._seekAttached = true;
            pb.addEventListener('click', e => {
                const rect = pb.getBoundingClientRect();
                const pct  = (e.clientX - rect.left) / rect.width;
                const player = getActivePlayer();
                const dur = player?.current_media?.duration || 0;
                if (dur > 0) seekTo(pct * dur);
            });
        }
    }

    // ─── Dashboard page init ───────────────────────────────────────────────────
    function initDashboard() {
        // Load files
        fetch('/api/files').then(r => r.json()).then(files => {
            window.allFiles = files;
            renderPlaylist(files);
        });

        // Init WaveSurfer
        initWaveSurfer();

        // Load MA players snapshot
        fetch('/api/ma/players').then(r => r.json()).then(players => {
            players.forEach(p => { window.maState.players[p.player_id] = p; });
            _resolveGroupPlayer();
            updateUIFromMA();

            // Set default device text
            const pid_ = window.maState.groupPlayerId;
            const gp   = pid_ ? window.maState.players[pid_] : null;
            const txt  = document.getElementById('selectedDeviceText');
            if (txt && gp) txt.textContent = gp.name;
        });

        // Bind big player controls
        const btnPlay = document.getElementById('btnPlay');
        if (btnPlay) btnPlay.addEventListener('click', togglePlay);
        const btnStop = document.getElementById('btnStop');
        if (btnStop) btnStop.addEventListener('click', stopPlayback);
        const btnNext = document.getElementById('btnNext');
        if (btnNext) btnNext.addEventListener('click', playNext);
        const btnPrev = document.getElementById('btnPrev');
        if (btnPrev) btnPrev.addEventListener('click', playPrev);

        // Volume slider
        const volSlider = document.getElementById('volSlider');
        if (volSlider) {
            const player = getActivePlayer();
            if (player) volSlider.value = player.group_volume ?? player.volume_level ?? 50;
            volSlider.addEventListener('change', e => setVolume(e.target.value));
        }

        // Volume icon mute
        const volIcon = document.getElementById('volIcon');
        if (volIcon) {
            volIcon.addEventListener('click', () => {
                const player = getActivePlayer();
                const vol    = player?.group_volume ?? player?.volume_level ?? 50;
                setVolume(vol > 0 ? 0 : 50);
            });
        }

        // Search
        const search = document.getElementById('searchInput');
        if (search) {
            search.addEventListener('input', e => {
                const q = e.target.value.toLowerCase();
                renderPlaylist(window.allFiles.filter(f => f.original_name.toLowerCase().includes(q)));
            });
        }
    }

    // ─── Devices page ──────────────────────────────────────────────────────────
    function initDevices() {
        function loadMAPlayers() {
            fetch('/api/ma/players').then(r => r.json()).then(players => {
                players.forEach(p => { window.maState.players[p.player_id] = p; });
                const grid = document.getElementById('maPlayerGrid');
                if (!grid) return;
                const syncPlayers = players.filter(p => p.in_sync_group || p.is_group);
                if (syncPlayers.length === 0) {
                    grid.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-12"><i class="fas fa-wifi-slash text-4xl mb-3 block"></i>No ESP32-Sync players discovered yet.</div>';
                    return;
                }
                grid.innerHTML = syncPlayers.map(p => {
                    const state  = p.playback_state || 'idle';
                    const vol    = p.group_volume ?? p.volume_level ?? 0;
                    const avail  = p.available;
                    const stateColors = { playing: 'green', paused: 'yellow', idle: 'gray', unknown: 'gray' };
                    const c      = stateColors[state] || 'gray';
                    const media  = p.current_media;
                    return `
                        <div class="glass rounded-2xl p-5 shadow-xl border border-white/10">
                            <div class="flex items-center justify-between mb-4">
                                <div class="flex items-center gap-3">
                                    <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/30 to-purple-500/30 flex items-center justify-center">
                                        <i class="fas ${p.is_group ? 'fa-layer-group' : 'fa-speaker'} text-blue-400"></i>
                                    </div>
                                    <div>
                                        <h3 class="font-bold text-gray-900 dark:text-white">${p.name}</h3>
                                        <p class="text-xs text-gray-500">${p.player_id}</p>
                                    </div>
                                </div>
                                <span class="px-2 py-1 rounded-full text-xs font-medium ${avail ? `bg-${c}-100 dark:bg-${c}-900/30 text-${c}-700 dark:text-${c}-300` : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}">
                                    ${avail ? state : 'offline'}
                                </span>
                            </div>
                            ${media ? `<div class="text-sm text-gray-600 dark:text-gray-400 truncate mb-3"><i class="fas fa-music mr-1 text-primary"></i>${media.title || 'Playing…'}</div>` : ''}
                            <div class="flex items-center gap-2 mt-2">
                                <i class="fas fa-volume-up text-gray-400 text-xs"></i>
                                <div class="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                    <div class="h-full bg-primary rounded-full transition-all" style="width:${vol}%"></div>
                                </div>
                                <span class="text-xs text-gray-500 font-mono w-8">${vol}%</span>
                            </div>
                            <div class="flex gap-2 mt-4">
                                <button onclick="maDevCmd('play_pause','${p.player_id}')" class="flex-1 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-colors"><i class="fas fa-play mr-1"></i>Play/Pause</button>
                                <button onclick="maDevCmd('stop','${p.player_id}')" class="flex-1 py-1.5 rounded-lg bg-red-100 dark:bg-red-900/20 hover:bg-red-200 text-red-600 text-xs font-medium transition-colors"><i class="fas fa-stop mr-1"></i>Stop</button>
                            </div>
                        </div>
                    `;
                }).join('');
            });
        }

        window.maDevCmd = function(cmd, playerId) {
            const fd = new FormData();
            fd.append('player_id', playerId);
            fetch('/api/ma/' + cmd, { method: 'POST', body: fd })
                .then(() => setTimeout(loadMAPlayers, 500));
        };

        loadMAPlayers();
        const ri = setInterval(loadMAPlayers, 5000);
        window._devicesRefreshInterval = ri;
    }

    // ─── Scheduler page ────────────────────────────────────────────────────────
    function initScheduler() {
        loadSchedules();
        initCalendar();

        const form = document.getElementById('schedulerForm');
        if (form) {
            form.addEventListener('submit', e => {
                e.preventDefault();
                submitSchedule();
            });
        }
        loadSchedulerDevices();
    }

    // ─── Global scheduler functions (accessible from HTML onclick) ─────────────
    window.setSchedRepeat = function(mode) {
        const repeatSelect = document.getElementById('repeatSelect');
        if (repeatSelect) repeatSelect.value = mode;
        // Update button styles
        ['none', 'daily', 'weekly', 'monthly'].forEach(m => {
            const btn = document.getElementById('btnRepeat_' + m);
            if (btn) {
                if (m === mode) {
                    btn.className = 'flex-1 py-1.5 rounded-full text-xs font-medium bg-primary text-white';
                } else {
                    btn.className = 'flex-1 py-1.5 rounded-full text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600';
                }
            }
        });
    };

    function loadSchedulerDevices() {
        const container = document.getElementById('targetDeviceContainer');
        if (!container) return;
        fetch('/api/ma/players').then(r => r.json()).then(players => {
            const groupPlayer = players.find(p => p.is_group && p.in_sync_group);
            const groupMembers = groupPlayer ? players.filter(p => p.in_sync_group && !p.is_group) : [];
            
            let html = '';
            
            // Group option
            if (groupPlayer) {
                html += `
                    <label class="flex items-center space-x-3 cursor-pointer p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded mb-2 border ${groupPlayer.available ? 'border-green-200 dark:border-green-800' : 'border-gray-300'}">
                        <input type="radio" name="targetDevice" value="${groupPlayer.player_id}" class="text-primary h-4 w-4" checked>
                        <i class="fas fa-layer-group text-blue-500"></i>
                        <span class="text-sm text-gray-900 dark:text-gray-200 font-medium">${groupPlayer.name} (Group)</span>
                        <span class="text-xs text-gray-500">All speakers</span>
                    </label>`;
            }
            
            // Individual speakers section
            if (groupMembers.length > 0) {
                html += '<div class="text-xs text-gray-500 px-1 mb-1 mt-2">Individual Speakers:</div>';
                html += groupMembers.map(p => `
                    <label class="flex items-center space-x-3 cursor-pointer p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded mb-1 ${p.available ? '' : 'opacity-50'}">
                        <input type="radio" name="targetDevice" value="${p.player_id}" class="text-primary h-4 w-4">
                        <i class="fas fa-volume-up text-gray-400"></i>
                        <span class="text-sm text-gray-900 dark:text-gray-200">${p.name}</span>
                    </label>`).join('');
            }
            
            // Fallback if no players found
            if (!groupPlayer && groupMembers.length === 0) {
                html = `
                    <label class="flex items-center space-x-3 cursor-pointer p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded">
                        <input type="radio" name="targetDevice" value="all" class="text-primary h-4 w-4" checked>
                        <span class="text-sm text-gray-900 dark:text-gray-200 font-medium">All ESP32-Sync (Group)</span>
                    </label>
                    <p class="text-xs text-gray-500 mt-2 px-1">Individual players will appear here when discovered...</p>`;
            }
            
            container.innerHTML = html;
        }).catch(() => {
            container.innerHTML = `
                <label class="flex items-center space-x-3 cursor-pointer p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded">
                    <input type="radio" name="targetDevice" value="all" class="text-primary h-4 w-4" checked>
                    <span class="text-sm text-gray-900 dark:text-gray-200 font-medium">All ESP32-Sync (Group)</span>
                </label>`;
        });
    }

    function loadSchedules() {
        fetch('/api/schedules').then(r => r.json()).then(schedules => {
            const tbody = document.getElementById('scheduleTableBody');
            if (!tbody) return;
            if (schedules.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-500">No schedules yet.</td></tr>';
                return;
            }
            tbody.innerHTML = schedules.map(s => {
                const dt = new Date(s.play_time);
                const dtStr = dt.toLocaleString();
                return `
                    <tr class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                        <td class="py-3 px-4 text-sm">${dtStr}</td>
                        <td class="py-3 px-4 text-sm font-medium truncate max-w-[200px]">${s.audio_name}</td>
                        <td class="py-3 px-4 text-sm text-gray-500">${s.device_name}</td>
                        <td class="py-3 px-4"><span class="px-2 py-1 text-xs rounded-full ${s.repeat !== 'none' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}">${s.repeat}</span></td>
                        <td class="py-3 px-4 text-right">
                            <button onclick="window.openScheduleModal(${s.id}, ${JSON.stringify(s).replace(/"/g, '&quot;')})" class="text-primary hover:text-blue-700 text-xs font-medium mr-2"><i class="fas fa-edit"></i></button>
                            <button onclick="deleteSchedule(${s.id})" class="text-red-400 hover:text-red-600 text-xs font-medium"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>
                `;
            }).join('');
        });
    }

    window.openScheduleModal = function(id, data) {
        const modal    = document.getElementById('scheduleModal');
        const titleEl  = document.getElementById('modalTitle');
        const editIdEl = document.getElementById('editingScheduleId');
        if (!modal) return;

        // Load audio files into select
        fetch('/api/files').then(r => r.json()).then(files => {
            window.allFiles = files;
            const sel = document.getElementById('audioSelect');
            if (sel) sel.innerHTML = files.map(f => `<option value="${f.id}">${f.original_name}</option>`).join('');
        });

        loadSchedulerDevices();

        if (id && data) {
            if (titleEl) titleEl.textContent = 'Edit Schedule';
            if (editIdEl) editIdEl.value = id;
            // Pre-fill form
            const dt = new Date(data.play_time);
            const dateEl = document.getElementById('dateSelect');
            const timeEl = document.getElementById('timeSelect');
            const timeDisplay = document.getElementById('timeDisplay');
            if (dateEl) dateEl.value = dt.toISOString().slice(0, 10);
            if (timeEl) {
                const t = dt.toTimeString().slice(0, 8);
                timeEl.value = t;
                if (timeDisplay) timeDisplay.textContent = t;
            }
            const volEl  = document.getElementById('scheduleVolumeSelect');
            const volVal = document.getElementById('schedVolVal');
            if (volEl)  volEl.value = data.volume;
            if (volVal) volVal.textContent = data.volume;
            if (typeof window.setSchedRepeat === 'function') window.setSchedRepeat(data.repeat || 'none');
        } else {
            if (titleEl) titleEl.textContent = 'Add Schedule';
            if (editIdEl) editIdEl.value = '';
            // Default date = today
            const dateEl = document.getElementById('dateSelect');
            if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    };

    window.closeScheduleModal = function() {
        const modal = document.getElementById('scheduleModal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    };

    function submitSchedule() {
        const editingId  = document.getElementById('editingScheduleId')?.value;
        const date       = document.getElementById('dateSelect')?.value;
        const time       = document.getElementById('timeSelect')?.value || '12:00:00';
        const audioId    = document.getElementById('audioSelect')?.value;
        const volume     = document.getElementById('scheduleVolumeSelect')?.value || 70;
        const repeat     = document.getElementById('repeatSelect')?.value || 'none';
        const deviceName = document.querySelector('input[name="targetDevice"]:checked')?.value || 'all';

        if (!date || !audioId) {
            Swal.fire({ toast: true, position: 'top-end', icon: 'warning', title: 'Please fill all fields', showConfirmButton: false, timer: 2000 });
            return;
        }

        const payload = {
            device_name: deviceName,
            audio_id:    parseInt(audioId),
            play_time:   `${date}T${time}`,
            repeat:      repeat,
            volume:      parseInt(volume),
        };

        const url    = editingId ? `/api/schedules/${editingId}` : '/api/schedules';
        const method = editingId ? 'PUT' : 'POST';

        fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(r => r.json()).then(() => {
            window.closeScheduleModal();
            loadSchedules();
            Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: editingId ? 'Schedule updated' : 'Schedule added', showConfirmButton: false, timer: 2000 });
        }).catch(() => Swal.fire('Error', 'Failed to save schedule', 'error'));
    }

    window.deleteSchedule = function(id) {
        Swal.fire({ title: 'Delete schedule?', icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444', confirmButtonText: 'Delete' })
            .then(r => {
                if (r.isConfirmed) {
                    fetch(`/api/schedules/${id}`, { method: 'DELETE' }).then(() => loadSchedules());
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
                    const events = scheds.map(s => {
                        const baseEvent = {
                            id:    s.id,
                            title: `${s.audio_name} (${s.repeat})`,
                            start: s.play_time,
                            color: s.repeat === 'weekly' ? '#8b5cf6' : (s.repeat === 'monthly' ? '#f59e0b' : '#3b82f6'),
                            extendedProps: { repeat: s.repeat, schedule: s }
                        };
                        
                        // For recurring schedules, set up recurrence via rrule
                        const rruleDays = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
                        if (s.repeat === 'daily') {
                            baseEvent.rrule = {
                                freq: 'daily',
                                dtstart: s.play_time
                            };
                        } else if (s.repeat === 'weekly') {
                            const dt = new Date(s.play_time);
                            baseEvent.rrule = {
                                freq: 'weekly',
                                byweekday: [ rruleDays[dt.getDay()] ],
                                dtstart: s.play_time
                            };
                        } else if (s.repeat === 'monthly') {
                            baseEvent.rrule = {
                                freq: 'monthly',
                                dtstart: s.play_time
                            };
                        }
                        return baseEvent;
                    });
                    success(events);
                });
            },
            eventClick: info => window.openScheduleModal(info.event.id, null),
            dateClick: info => {
                // Open schedule modal with clicked date pre-filled
                window.openScheduleModal(null, null);
                // Set the date after modal opens
                setTimeout(() => {
                    const dateEl = document.getElementById('dateSelect');
                    if (dateEl) dateEl.value = info.dateStr;
                }, 100);
            },
            eventContent: function(arg) {
                const repeat = arg.event.extendedProps?.repeat || 'none';
                const icons = {
                    'none': 'fa-calendar',
                    'daily': 'fa-calendar-day',
                    'weekly': 'fa-calendar-week',
                    'monthly': 'fa-calendar-alt'
                };
                const icon = icons[repeat] || 'fa-calendar';
                return { html: `<div class="flex items-center gap-1"><i class="fas ${icon} mr-1"></i>${arg.event.title}</div>` };
            },
        });
        cal.render();
        // Store calendar instance for date click handling
        window._calendarInstance = cal;
    }

    // ─── Config page ───────────────────────────────────────────────────────────
    function initConfig() {
        fetch('/api/config').then(r => r.json()).then(conf => {
            if (!conf) return;
            const vol = document.getElementById('cfgVol');
            const volVal = document.getElementById('cfgVolVal');
            if (vol) { vol.value = conf.default_volume || 50; }
            if (volVal) volVal.textContent = (conf.default_volume || 50) + '%';
            if (vol) vol.addEventListener('input', e => { if (volVal) volVal.textContent = e.target.value + '%'; });

            const tz = document.getElementById('cfgTz');
            if (tz) tz.value = conf.timezone || 'Asia/Jayapura';
            const lang = document.getElementById('cfgLang');
            if (lang) lang.value = conf.language || 'en';

            const tcEnable = document.getElementById('cfgTcEnable');
            const tcOpts   = document.getElementById('cfgTcOptions');
            if (tcEnable) {
                tcEnable.checked = conf.transcode_enabled;
                if (tcOpts) tcOpts.classList.toggle('hidden', !conf.transcode_enabled);
                tcEnable.addEventListener('change', e => {
                    if (tcOpts) tcOpts.classList.toggle('hidden', !e.target.checked);
                    updateTranscodeFormats();
                });
            }
            const tcType = document.getElementById('cfgTcType');
            if (tcType) {
                tcType.value = conf.transcode_type || 'lossy';
                tcType.addEventListener('change', updateTranscodeFormats);
            }
            const tcFmt  = document.getElementById('cfgTcFormat');
            const tcBit  = document.getElementById('cfgTcBitrate');
            const tcRate = document.getElementById('cfgTcSampleRate');
            if (tcRate) tcRate.value = conf.transcode_samplerate || '44100';

            function updateTranscodeFormats() {
                const type = document.getElementById('cfgTcType')?.value;
                if (tcFmt) {
                    if (type === 'lossy') {
                        tcFmt.innerHTML = '<option value="mp3">MP3</option><option value="aac">AAC</option><option value="ogg">OGG Vorbis</option>';
                        if (tcBit) tcBit.innerHTML = '<option value="64k">64 kbps</option><option value="96k">96 kbps</option><option value="128k" selected>128 kbps</option><option value="192k">192 kbps</option><option value="320k">320 kbps</option>';
                    } else {
                        tcFmt.innerHTML = '<option value="flac">FLAC</option><option value="wav">WAV</option>';
                        if (tcBit) tcBit.innerHTML = '<option value="16bit">16-bit</option><option value="24bit">24-bit</option>';
                    }
                    tcFmt.value = conf.transcode_format || (type === 'lossy' ? 'mp3' : 'flac');
                    if (tcBit) tcBit.value = conf.transcode_bitrate || (type === 'lossy' ? '128k' : '16bit');
                }
            }
            updateTranscodeFormats();
        });

        const form = document.getElementById('configForm');
        if (form) {
            form.addEventListener('submit', async e => {
                e.preventDefault();
                const fd = new FormData(form);
                const tcEnable = document.getElementById('cfgTcEnable');
                fd.set('transcode_enabled', tcEnable?.checked ? 'true' : 'false');
                await fetch('/api/config', { method: 'POST', body: fd });
                Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Settings saved', showConfirmButton: false, timer: 2000 });
            });
        }

        // MA status in config page
        fetch('/api/ma/status').then(r => r.json()).then(st => {
            const maUrl   = document.getElementById('cfgMaUrl');
            const maGroup = document.getElementById('cfgMaGroup');
            const maConn  = document.getElementById('cfgMaConn');
            if (maUrl)   maUrl.textContent   = st.ma_url;
            if (maGroup) maGroup.textContent  = st.group_player_name + (st.group_player_id ? ` (${st.group_player_id})` : '');
            if (maConn)  maConn.innerHTML     = st.connected
                ? '<span class="text-green-500"><i class="fas fa-check-circle mr-1"></i>Connected</span>'
                : '<span class="text-red-400"><i class="fas fa-times-circle mr-1"></i>Disconnected</span>';
        }).catch(() => {});
    }

    // ─── Page dispatcher ───────────────────────────────────────────────────────
    window.initPageScripts = function(url) {
        // Clean up devices refresh interval on nav away
        if (window._devicesRefreshInterval && url !== '/devices') {
            clearInterval(window._devicesRefreshInterval);
            window._devicesRefreshInterval = null;
        }
        if (url === '/' || url === '') initDashboard();
        else if (url === '/devices')   initDevices();
        else if (url === '/scheduler') initScheduler();
        else if (url === '/config')    initConfig();
    };

    // ─── Mini player bindings ──────────────────────────────────────────────────
    if (miniBtnPlay) miniBtnPlay.addEventListener('click', togglePlay);
    if (miniBtnNext) miniBtnNext.addEventListener('click', playNext);
    if (miniBtnPrev) miniBtnPrev.addEventListener('click', playPrev);

    if (miniVolSlider) {
        miniVolSlider.addEventListener('change', e => setVolume(e.target.value));
    }

    // ─── Kick off ─────────────────────────────────────────────────────────────
    connectWebSocket();
    window.initPageScripts(location.pathname);

});  // DOMContentLoaded
