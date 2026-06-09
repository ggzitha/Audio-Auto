// app/static/spa.js
// COMPLETE REWRITE - fixes SPA audio continuity, cross-client sync, and all known bugs.
document.addEventListener('DOMContentLoaded', () => {

    const mainContent = document.getElementById('spa-content');
    const bottomPlayer = document.getElementById('bottom-player');
    // ─── Native SendspinPlayer Integration ────────────────────────────────────
    let storedPlayerId = localStorage.getItem('sendspin_player_id');
    if (!storedPlayerId) {
        storedPlayerId = 'webapp-' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('sendspin_player_id', storedPlayerId);
    }

    // Track late joiner state
    let isLateJoiner = false;
    let lateJoinerTargetPosition = 0;
    
    window.sendspinPlayer = new SendspinJS.SendspinPlayer({
        playerId: storedPlayerId,
        clientName: 'Web App',
        baseUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:8927`,
        onStateChange: (state) => {
            // Handle late joiner: when stream starts playing, seek to current position
            if (isLateJoiner && state === 'playing' && lateJoinerTargetPosition > 0) {
                console.log('[Sendspin] Late joiner: seeking to', lateJoinerTargetPosition.toFixed(1), 's');
                window.sendspinPlayer.seekTo(lateJoinerTargetPosition);
                isLateJoiner = false;
            }
        }
    });

    window.sendspinPlayer.connect().catch(e => console.error('Sendspin connect error:', e));

    const resumeAudioCtx = () => {
        const ctx = window.sendspinPlayer?.scheduler?.audioContext;
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().then(() => {
                console.log('[Audio] AudioContext resumed via user interaction');
                hideAudioJoinOverlay();
            });
        }
    };

    // Resume on ANY user interaction — covers late joiners
    ['click', 'touchstart', 'keydown', 'pointerdown'].forEach(evt => {
        document.addEventListener(evt, resumeAudioCtx, { passive: true });
    });

    // ─── Audio Join Overlay Logic ─────────────────────────────────────────────
    const audioJoinOverlay = document.getElementById('audioJoinOverlay');
    const audioJoinBtn = document.getElementById('audioJoinBtn');
    let overlayShown = false;

    function showAudioJoinOverlay() {
        if (audioJoinOverlay && !overlayShown) {
            audioJoinOverlay.classList.remove('hidden');
            overlayShown = true;
        }
    }

    function hideAudioJoinOverlay() {
        if (audioJoinOverlay) {
            audioJoinOverlay.classList.add('hidden');
            overlayShown = false;
        }
    }

    if (audioJoinBtn) {
        audioJoinBtn.addEventListener('click', () => {
            resumeAudioCtx();
            hideAudioJoinOverlay();
        });
    }

    // Periodically check if AudioContext is suspended while playback is active
    setInterval(() => {
        const ctx = window.sendspinPlayer?.scheduler?.audioContext;
        if (ctx && ctx.state === 'suspended' && window.globalState?.is_playing) {
            showAudioJoinOverlay();
        } else if (ctx && ctx.state === 'running') {
            hideAudioJoinOverlay();
        }
    }, 500);
    // ─── Global Playback State ────────────────────────────────────────────────
    window.globalState = {
        audio_id: null,
        is_playing: false,
        position: 0,       // position at last_updated
        volume: 50,
        previousVolume: 50,
        speed: 1.0,
        deviceLogs: {},    // Persist logs across SPA navigations
        autoScroll: {},    // Auto-scroll state per device
        last_updated: 0,   // server unix timestamp when position was captured
        server_time: 0,    // server's clock at time of broadcast
        current_position: 0
    };

    window.allFiles = [];
    window.playTimeoutId = null;

    // localAudio removed, handled by SendspinPlayer

    // ─── WaveSurfer (singleton, lives forever) ────────────────────────────────
    let wavesurfer = null;
    let wavesurferInitialized = false;
    let currentLoadedAudioId = null;
    // Persistent container so WaveSurfer doesn't get destroyed on SPA nav
    let globalWaveformContainer = document.createElement('div');
    globalWaveformContainer.id = "persistentWaveform";

    // ─── Mini-player element refs ─────────────────────────────────────────────
    const miniBtnPlay = document.getElementById('miniBtnPlay');
    const miniPlayIcon = document.getElementById('miniPlayIcon');
    const miniBtnNext = document.getElementById('miniBtnNext');
    const miniBtnPrev = document.getElementById('miniBtnPrev');
    const miniSongTitle = document.getElementById('miniSongTitle');
    const miniTimeElapsed = document.getElementById('miniTimeElapsed');
    const miniTimeTotal = document.getElementById('miniTimeTotal');
    const miniProgressOverlay = document.getElementById('miniProgressOverlay');
    const miniProgressBarContainer = document.getElementById('miniProgressBarContainer');
    const miniVolSlider = document.getElementById('miniVolSlider');

    // ─── Routing ──────────────────────────────────────────────────────────────
    function updatePlayerVisibility(url) {
        // Show mini player on all pages EXCEPT the dashboard (which has the full player)
        if (url === '/' || url === '') {
            if (bottomPlayer) bottomPlayer.classList.add('hidden');
        } else {
            if (bottomPlayer && window.globalState.audio_id) {
                bottomPlayer.classList.remove('hidden');
            }
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

                    // CRITICAL FIX: Browser does NOT execute <script> tags injected
                    // via innerHTML. We must manually re-create and append each one.
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

    window.addEventListener('popstate', () => {
        loadPage(location.pathname);
    });

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
    // FIX v2.1: Add state update lock to prevent race conditions between
    // WebSocket state updates and SendspinPlayer state changes.
    let stateUpdateInProgress = false;
    let pendingStateUpdate = null;

    function connectWebSocket() {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

        ws.onopen = () => {
            console.log('WebSocket connected');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'log') {
                    if (!window.globalState.deviceLogs) window.globalState.deviceLogs = {};
                    if (!window.globalState.deviceLogs[data.device]) window.globalState.deviceLogs[data.device] = [];
                    window.globalState.deviceLogs[data.device].push(`[${new Date().toLocaleTimeString()}] ${data.text}`);
                    if (window.globalState.deviceLogs[data.device].length > 50) window.globalState.deviceLogs[data.device].shift();
                    window.dispatchEvent(new CustomEvent('deviceLog', { detail: data }));
                } else if (data.type === 'transcode_progress') {
                    if (data.status === 'started') {
                        Swal.fire({
                            title: 'Transcoding Audio',
                            html: `<div class="text-sm mb-4">Processing <b>${data.file}</b>...</div><div class="flex justify-center"><i class="fas fa-cog fa-spin text-4xl text-primary"></i></div>`,
                            allowOutsideClick: false,
                            showConfirmButton: false,
                            customClass: { popup: 'glass' }
                        });
                    } else if (data.status === 'done') {
                        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Transcoding complete', text: data.file, showConfirmButton: false, timer: 3000, customClass: { popup: 'glass' } });
                        fetch('/api/files').then(r => r.json()).then(files => { window.allFiles = files; renderPlaylist(files); });
                    } else if (data.status === 'error') {
                        Swal.fire('Transcode Failed', `Failed to transcode ${data.file}`, 'error');
                    }
                } else if (data.type === 'state') {
                    // FIX v2.1: Use queue to prevent concurrent state updates
                    if (stateUpdateInProgress) {
                        pendingStateUpdate = data.state;
                        return;
                    }
                    stateUpdateInProgress = true;
                    applyServerState(data.state);
                    stateUpdateInProgress = false;
                    // Process pending state if any
                    if (pendingStateUpdate) {
                        const nextState = pendingStateUpdate;
                        pendingStateUpdate = null;
                        setTimeout(() => {
                            stateUpdateInProgress = true;
                            applyServerState(nextState);
                            stateUpdateInProgress = false;
                        }, 0);
                    }
                }
            } catch (e) { console.error('WS message parse error:', e); }
        };

        ws.onclose = () => {
            wsReconnectTimer = setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = () => {
            ws.close();
        };
    }

    // ─── State Sync Logic ─────────────────────────────────────────────────────
    function applyServerState(state) {
        window.globalState = { ...window.globalState, ...state };

        // Compute actual current playback position
        let actualPosition = state.position || 0;
        let delayMs = 0;
        if (state.is_playing && state.last_updated > 0 && state.server_time > 0) {
            const timeUntilStart = state.last_updated - state.server_time;
            if (timeUntilStart > 0) {
                delayMs = timeUntilStart * 1000;
                actualPosition = state.position || 0;
            } else {
                const elapsed = -timeUntilStart;
                actualPosition = (state.position || 0) + elapsed * (state.speed || 1.0);
            }
            actualPosition = Math.max(0, actualPosition);
        }
        window.globalState.current_position = actualPosition;

        // Load new audio file into wavesurfer (visual only)
        const fileObj = window.allFiles.find(f => f.id === state.audio_id);
        if (fileObj && state.audio_id !== currentLoadedAudioId) {
            currentLoadedAudioId = state.audio_id;
            if (wavesurfer) {
                wavesurfer.load(`/audio_files/${encodeURIComponent(fileObj.filename)}`).catch(e => {
                    if (e.name !== 'AbortError') console.error(e);
                });
            }
        }

        // Sync volume
        if (state.volume !== undefined && window.sendspinPlayer) {
            window.sendspinPlayer.setVolume(state.volume);
        }

        updateUIFromState();
    }

    // ─── UI Update ────────────────────────────────────────────────────────────
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function updateUIFromState() {
        const state = window.globalState;

        // Song title
        if (state.audio_id && window.allFiles.length > 0) {
            const fileObj = window.allFiles.find(f => f.id === state.audio_id);
            if (fileObj) {
                if (miniSongTitle) miniSongTitle.innerText = fileObj.original_name;
                const bigTitle = document.getElementById('nowPlaying');
                if (bigTitle) bigTitle.innerText = fileObj.original_name;
                const bigArtist = document.getElementById('nowPlayingArtist');
                if (bigArtist) bigArtist.innerText = state.is_playing ? 'Playing...' : 'Paused';
            }
        } else {
            const bigTitle = document.getElementById('nowPlaying');
            if (bigTitle) bigTitle.innerText = 'Ready';
            const bigArtist = document.getElementById('nowPlayingArtist');
            if (bigArtist) bigArtist.innerText = 'Audio-Auto System';
            if (miniSongTitle) miniSongTitle.innerText = 'Ready';
        }

        // Play/Pause icons
        if (miniPlayIcon) {
            miniPlayIcon.className = state.is_playing
                ? "fas fa-pause-circle text-2xl md:text-3xl"
                : "fas fa-play-circle text-2xl md:text-3xl";
        }
        const bigPlayIcon = document.getElementById('playIcon');
        if (bigPlayIcon) {
            bigPlayIcon.className = state.is_playing
                ? "fas fa-pause-circle text-5xl md:text-6xl drop-shadow-md"
                : "fas fa-play-circle text-5xl md:text-6xl drop-shadow-md";
        }

        // Playlist highlight
        const currentItems = document.querySelectorAll('#playlistContainer > div');
        currentItems.forEach(el => el.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary'));
        if (state.audio_id) {
            const activeEl = document.querySelector(`#playlistContainer > div[data-id="${state.audio_id}"]`);
            if (activeEl) activeEl.classList.add('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
        }

        // Volume sliders (don't update while user is dragging)
        if (state.volume !== undefined) {
            const volSlider = document.getElementById('volSlider');
            if (volSlider && document.activeElement !== volSlider) volSlider.value = state.volume;
            if (miniVolSlider && document.activeElement !== miniVolSlider) miniVolSlider.value = state.volume;
        }

        // Mini player visibility
        if (state.audio_id && location.pathname !== '/') {
            if (bottomPlayer) bottomPlayer.classList.remove('hidden');
        }
    }

    // ─── API Commands & Modal Logic ───────────────────────────────────────────
    let selectedDevices = new Set(['all']);

    function getTargetDevice() {
        if (selectedDevices.has('all')) return 'all';
        return Array.from(selectedDevices).join(',');
    }

    window.openDeviceModal = function() {
        const modal = document.getElementById('deviceModal');
        const content = document.getElementById('deviceModalContent');
        if (modal && content) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => {
                content.classList.remove('scale-95', 'opacity-0');
                content.classList.add('scale-100', 'opacity-100');
            }, 10);
        }
        window.renderDeviceModalList();
    };

    window.closeDeviceModal = function() {
        const modal = document.getElementById('deviceModal');
        const content = document.getElementById('deviceModalContent');
        if (modal && content) {
            content.classList.remove('scale-100', 'opacity-100');
            content.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 300);
        }
    };

    window.selectAllDevices = function() {
        selectedDevices.clear();
        selectedDevices.add('all');
        window.renderDeviceModalList();
    };

    window.deselectAllDevices = function() {
        selectedDevices.clear();
        window.renderDeviceModalList();
    };

    window.toggleDeviceSelection = function(devName) {
        if (selectedDevices.has('all')) {
            selectedDevices.clear();
        }
        if (selectedDevices.has(devName)) {
            selectedDevices.delete(devName);
        } else {
            selectedDevices.add(devName);
        }
        if (selectedDevices.size === 0) {
            selectedDevices.add('all');
        }
        window.renderDeviceModalList();
    };

    window.applyDeviceSelection = function() {
        const text = document.getElementById('selectedDeviceText');
        if (text) {
            if (selectedDevices.has('all')) {
                text.innerText = 'All Devices';
            } else {
                const arr = Array.from(selectedDevices);
                if (arr.length === 1) text.innerText = arr[0];
                else text.innerText = arr.length + ' Devices Selected';
            }
        }
        window.closeDeviceModal();
    };

    window.renderDeviceModalList = function() {
        const list = document.getElementById('deviceModalList');
        if (!list) return;
        fetch('/api/devices').then(r => r.json()).then(devices => {
            devices = devices.filter(d => d.name !== 'Web App');
            if (devices.length === 0) {
                list.innerHTML = '<div class="text-center text-sm text-gray-500 py-4">No devices found.</div>';
                return;
            }
            list.innerHTML = devices.map(d => {
                const isSelected = selectedDevices.has('all') || selectedDevices.has(d.name);
                const isOnline = d.status === 'online';
                return `
                    <div onclick="window.toggleDeviceSelection('${d.name}')" class="flex items-center justify-between p-3 rounded-lg border ${isSelected ? 'border-primary bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'} cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                        <div class="flex items-center space-x-3">
                            <div class="w-8 h-8 rounded-full ${isOnline ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'} flex items-center justify-center">
                                <i class="fas fa-speaker"></i>
                            </div>
                            <div>
                                <h4 class="font-semibold text-gray-800 dark:text-gray-200">${d.name}</h4>
                                <p class="text-xs text-gray-500">${isOnline ? 'Online' : 'Offline'} • ${d.ip_address || 'N/A'}</p>
                            </div>
                        </div>
                        <div class="text-primary">
                            <i class="fas ${isSelected ? 'fa-check-circle text-lg' : 'fa-circle text-gray-300 dark:text-gray-600'}"></i>
                        </div>
                    </div>
                `;
            }).join('');
        });
    };

    function pushStateChange(action, payload) {
        const formData = new FormData();
        formData.append('device_name', getTargetDevice());
        for (const [key, value] of Object.entries(payload)) {
            formData.append(key, value);
        }
        return fetch('/api/' + action, { method: 'POST', body: formData });
    }

    window.selectSong = function (id) {
        const fileObj = window.allFiles.find(f => f.id === id);
        if (!fileObj) return;

        // Mark as loading BEFORE the server round-trip so applyServerState
        // doesn't trigger a second wavesurfer.load() for the same song.
        currentLoadedAudioId = id;

        const audioSrc = `/audio_files/${encodeURIComponent(fileObj.filename)}`;
        // Let wavesurfer.load() drive the loading if available;
        if (wavesurfer) {
            wavesurfer.load(audioSrc).catch(e => {
                if (e.name !== 'AbortError') console.error(e);
            });
        }

        // Tell server to start playback via Sendspin (all clients receive audio via Sendspin)
        const formData = new FormData();
        formData.append('audio_id', id);
        formData.append('volume', window.globalState.volume);
        formData.append('position', 0);
        fetch('/api/play', { method: 'POST', body: formData });
    };

    function togglePlay() {
        if (!window.globalState.audio_id) {
            if (window.allFiles.length > 0) window.selectSong(window.allFiles[0].id);
            return;
        }
        if (window.globalState.is_playing) {
            pushStateChange('stop', {});
        } else {
            // Resume from current position
            const pos = window.globalState.current_position || window.globalState.position;
            pushStateChange('play', {
                audio_id: window.globalState.audio_id,
                volume: window.globalState.volume,
                position: pos
            });
        }
    }

    function playNext() {
        if (window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => f.id === window.globalState.audio_id);
        idx = (idx + 1) % window.allFiles.length;
        window.selectSong(window.allFiles[idx].id);
    }

    function playPrev() {
        if (window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => f.id === window.globalState.audio_id);
        idx = (idx - 1 + window.allFiles.length) % window.allFiles.length;
        window.selectSong(window.allFiles[idx].id);
    }

    function stopPlayback() {
        if (!window.globalState.audio_id) return;
        pushStateChange('stop', { clear: true });
    }

    function toggleMute() {
        const state = window.globalState;
        if (state.volume > 0) {
            state.previousVolume = state.volume;
            pushStateChange('volume', { volume: 0 });
        } else {
            pushStateChange('volume', { volume: state.previousVolume || 50 });
        }
    }

    // ─── WaveSurfer Initialization ────────────────────────────────────────────

    function initWaveSurfer() {
        const container = document.getElementById('waveformContainer');
        if (!container) return;

        // UI Update interval based on server state extrapolation
        if (!window.sendspinPlayerUIInterval) {
            window.sendspinPlayerUIInterval = setInterval(() => {
                if (window.globalState && window.globalState.is_playing) {
                    const elapsed = (Date.now() / 1000) - window.globalState.last_updated;
                    let currentTime = window.globalState.position + (elapsed * (window.globalState.speed || 1.0));
                    
                    const dur = wavesurfer ? wavesurfer.getDuration() : 0;
                    if (dur > 0 && currentTime > dur) currentTime = dur;

                    // update wavesurfer UI visually without triggering its audio
                    if (wavesurfer && dur > 0) {
                        wavesurfer.seekTo(currentTime / dur);
                    }

                    const t = formatTime(currentTime);
                    const timeElapsed = document.getElementById('timeElapsed');
                    if (timeElapsed && timeElapsed.innerText !== t) timeElapsed.innerText = t;
                    if (miniTimeElapsed && miniTimeElapsed.innerText !== t) miniTimeElapsed.innerText = t;

                    if (dur > 0) {
                        const pct = (currentTime / dur) * 100;
                        if (miniProgressOverlay) miniProgressOverlay.style.width = pct + '%';
                        const progressBar = document.getElementById('progressBar');
                        if (progressBar) progressBar.style.width = pct + '%';
                    }
                }
            }, 100);
        }

        if (typeof WaveSurfer === 'undefined') {
            console.error("WaveSurfer not loaded!");
            return;
        }

        container.innerHTML = '';
        container.appendChild(globalWaveformContainer);

        if (wavesurferInitialized) {
            _attachDashboardWaveSurferEvents();
            return;
        }
        wavesurferInitialized = true;

        wavesurfer = WaveSurfer.create({
            container: globalWaveformContainer,
            waveColor: 'rgba(59, 130, 246, 0.4)',
            progressColor: 'rgba(59, 130, 246, 1)',
            barWidth: 2,
            barGap: 2,
            barRadius: 2,
            height: 64,
            normalize: true,
            interact: true
        });

        wavesurfer.on('interaction', () => {
            if (window.globalState && window.globalState.audio_id) {
                const newTime = wavesurfer.getCurrentTime();
                pushStateChange('play', {
                    audio_id: window.globalState.audio_id,
                    volume: window.globalState.volume,
                    position: newTime
                });
            }
        });

        if (window.globalState.audio_id) {
            const fileObj = window.allFiles.find(f => f.id === window.globalState.audio_id);
            if (fileObj) {
                wavesurfer.load(`/audio_files/${encodeURIComponent(fileObj.filename)}`).catch(e => {
                    if (e.name !== 'AbortError') console.error(e);
                });
            }
        }

        wavesurfer.on('ready', () => {
            const dur = wavesurfer.getDuration();
            const timeTotal = document.getElementById('timeTotal');
            if (timeTotal) timeTotal.innerText = formatTime(dur);
            if (miniTimeTotal) miniTimeTotal.innerText = formatTime(dur);

            if (window.globalState.audio_id) {
                const fileObj = window.allFiles.find(f => f.id === window.globalState.audio_id);
                if (fileObj && (!fileObj.duration_sec || fileObj.duration_sec === 0)) {
                    fileObj.duration_sec = dur;
                    const el = document.querySelector(`#playlistContainer > div[data-id="${fileObj.id}"] p`);
                    if (el) el.innerText = formatTime(dur);
                }
            }
        });


        _attachDashboardWaveSurferEvents();
    }

    function _attachDashboardWaveSurferEvents() {
        if (!wavesurfer) return;
        // Since interact is false, the user can't click to seek on the waveform directly.
        // If we want to allow seeking, we'd enable interact and handle the 'interaction' event.
        // For now, seeking is handled by pushing state manually.
        
        if (wavesurfer.getDuration && wavesurfer.getDuration() > 0) {
            const dur = wavesurfer.getDuration();
            const timeTotal = document.getElementById('timeTotal');
            if (timeTotal) timeTotal.innerText = formatTime(dur);
            if (miniTimeTotal) miniTimeTotal.innerText = formatTime(dur);
        }
    }

    // ─── Page Scripts ─────────────────────────────────────────────────────────
    window.initPageScripts = function (url) {
        if (url === '/' || url === '') initDashboard();
        else if (url === '/devices') initDevices();
        else if (url === '/scheduler') initScheduler();
        else if (url === '/config') initConfig();
    };

    let syncChart = null;
    let syncInterval = null;

    function initSyncChart() {
        const ctx = document.getElementById('sendspin-demo-sync-graph');
        if (!ctx) return;
        
        if (syncChart) syncChart.destroy();
        
        syncChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                scales: {
                    x: { display: false },
                    y: { 
                        title: { display: true, text: 'Offset (ms)' },
                        grid: { color: 'rgba(156, 163, 175, 0.2)' }
                    }
                },
                plugins: {
                    legend: { position: 'top', labels: { color: '#9ca3af' } }
                }
            }
        });
    }

    function updateSyncData() {
        if (window.location.pathname !== '/' && window.location.pathname !== '') return;
        
        fetch('/api/sendspin/clients').then(r => r.json()).then(clients => {
            const viz = document.getElementById('timingVizContainer');
            if (viz) {
                if (clients.length === 0) {
                    viz.innerHTML = '<div class="text-sm text-gray-500 text-center py-4">Waiting for device data...</div>';
                } else {
                    viz.innerHTML = clients.map(c => {
                        const rttMs = (c.last_rtt_us / 1000).toFixed(1);
                        const offsetMs = (c.sync_offset_us / 1000).toFixed(2);
                        const syncCount = c.sync_count || 0;
                        const rttColor = c.last_rtt_us < 5000 ? 'text-green-500' : c.last_rtt_us < 20000 ? 'text-yellow-500' : 'text-red-500';
                        const offsetColor = Math.abs(c.sync_offset_us) < 1000 ? 'text-green-500' : Math.abs(c.sync_offset_us) < 5000 ? 'text-yellow-500' : 'text-red-500';
                        return `
                            <div class="flex justify-between items-center p-2 rounded bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                                <div class="flex items-center space-x-2">
                                    <i class="fas fa-microchip text-primary"></i>
                                    <span class="font-medium">${c.name || c.id}</span>
                                </div>
                                <div class="flex space-x-4 text-xs font-mono">
                                    <span class="${rttColor}" title="Round Trip Time"><i class="fas fa-exchange-alt mr-1"></i>${rttMs}ms RTT</span>
                                    <span class="${offsetColor}" title="Sync Offset"><i class="fas fa-clock mr-1"></i>${offsetMs}ms offset</span>
                                    <span class="text-blue-500" title="Sync Count"><i class="fas fa-sync mr-1"></i>${syncCount} syncs</span>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }

            if (syncChart) {
                const now = new Date().toLocaleTimeString();
                syncChart.data.labels.push(now);
                if (syncChart.data.labels.length > 30) syncChart.data.labels.shift();

                clients.forEach((c, i) => {
                    let ds = syncChart.data.datasets.find(d => d.label === (c.name || c.id));
                    if (!ds) {
                        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
                        ds = {
                            label: c.name || c.id,
                            data: Array(syncChart.data.labels.length - 1).fill(null),
                            borderColor: colors[i % colors.length],
                            borderWidth: 2,
                            tension: 0.4,
                            pointRadius: 2,
                            pointBackgroundColor: colors[i % colors.length],
                        };
                        syncChart.data.datasets.push(ds);
                    }
                    // Plot real sync offset in milliseconds
                    const offsetMs = c.sync_offset_us ? (c.sync_offset_us / 1000) : 0;
                    ds.data.push(offsetMs);
                    if (ds.data.length > 30) ds.data.shift();
                });

                syncChart.update();
            }
        }).catch(e => console.error("Sync data error:", e));
    }

    function initDashboard() {
        initWaveSurfer();
        initSyncChart();
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(updateSyncData, 1000);

        // Bind player controls
        const btnPlay = document.getElementById('btnPlay');
        if (btnPlay) btnPlay.addEventListener('click', togglePlay);
        const btnStop = document.getElementById('btnStop');
        if (btnStop) btnStop.addEventListener('click', stopPlayback);
        const btnNext = document.getElementById('btnNext');
        if (btnNext) btnNext.addEventListener('click', playNext);
        const btnPrev = document.getElementById('btnPrev');
        if (btnPrev) btnPrev.addEventListener('click', playPrev);

        const volIcon = document.getElementById('volIcon');
        if (volIcon) volIcon.addEventListener('click', toggleMute);

        const volSlider = document.getElementById('volSlider');
        if (volSlider) {
            volSlider.value = window.globalState.volume;
            volSlider.addEventListener('input', e => {
                if (window.sendspinPlayer && typeof window.sendspinPlayer.setVolume === 'function') {
                    window.sendspinPlayer.setVolume(e.target.value / 100.0);
                }
            });
            volSlider.addEventListener('change', e => {
                pushStateChange('volume', { volume: e.target.value });
            });
        }

        
        // ─── Codec Selector ───────────────────────────────────────────────────────
        // Ensure updateGlobalCodec is defined at global scope BEFORE any page loads
        window.updateGlobalCodec = function() {
            try {
                const codecSelect = document.getElementById('codecSelect');
                if (!codecSelect) {
                    console.error('CodecSelect element not found');
                    return;
                }
                const val = codecSelect.value;
                console.log('Updating codec to:', val);
                fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ codec: val })
                })
                .then(r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(res => {
                    if (res.status === 'ok') {
                        console.log('Codec successfully updated to', val);
                    } else {
                        console.error('Codec update failed:', res);
                    }
                })
                .catch(e => console.error("Codec update error:", e));
            } catch (err) {
                console.error("updateGlobalCodec exception:", err);
            }
        };

        // Load current codec setting on page init
        const codecSelect = document.getElementById('codecSelect');
        if (codecSelect) {
            fetch('/api/settings')
                .then(r => r.json())
                .then(settings => {
                    codecSelect.value = settings.codec || 'pcm';
                    console.log('Loaded codec setting:', settings.codec);
                })
                .catch(e => console.error("Settings fetch error:", e));
        }

        // No longer load devices into a <select>
        // We use Device Modal instead.

        // Load file list
        fetch('/api/files').then(r => r.json()).then(files => {
            window.allFiles = files;
            window.renderPlaylist(files);
            updateUIFromState();
        });

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', e => {
                const q = e.target.value.toLowerCase();
                const filtered = window.allFiles.filter(f => f.original_name.toLowerCase().includes(q));
                window.renderPlaylist(filtered);
            });
        }

        const playlistContainer = document.getElementById('playlistContainer');
        window.renderPlaylist = function(files) {
            if (!playlistContainer) return;
            if (files.length === 0) {
                playlistContainer.innerHTML = '<div class="p-8 text-center text-gray-500">No audio files.</div>';
                return;
            }
            playlistContainer.innerHTML = files.map(f => `
                <div class="flex items-center justify-between px-6 py-4 hover:bg-gray-50 dark:hover:bg-[#253246] transition-colors group cursor-pointer" data-id="${f.id}">
                    <div class="flex items-center space-x-4" onclick="window.selectSong(${f.id})">
                        <div class="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                            <i class="fas fa-music"></i>
                        </div>
                        <div>
                            <h4 class="font-semibold text-gray-800 dark:text-gray-200">${f.original_name}</h4>
                            <p class="text-xs text-gray-500 mt-1">${formatTime(f.duration_sec || 0)}</p>
                        </div>
                    </div>
                    <div class="flex items-center space-x-3">
                        <button onclick="window.deleteFile(${f.id})" class="text-red-400 hover:text-red-600 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `).join('');

            updateUIFromState();
        }

        window.deleteFile = function (id) {
            Swal.fire({
                title: 'Delete file?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Yes, delete it'
            }).then(res => {
                if (res.isConfirmed) {
                    if (window.globalState && window.globalState.audio_id === id) {
                        pushStateChange('stop', { clear: true });
                    }
                    fetch('/api/files/' + id, { method: 'DELETE' }).then(() => {
                        fetch('/api/files').then(r => r.json()).then(files => {
                            window.allFiles = files;
                            window.renderPlaylist(files);
                        });
                    });
                }
            });
        };
    }

    function initDevices() {
        const grid = document.getElementById('deviceGrid');
        if (!grid) return;

        function renderDevices() {
            fetch('/api/devices').then(r => r.json()).then(devices => {
                devices = devices.filter(d => d.name !== 'Web App');
                if (devices.length === 0) {
                    grid.innerHTML = '<div class="col-span-full text-center py-10 text-gray-500">No devices registered.</div>';
                    return;
                }
                devices.forEach(d => {
                    let card = document.getElementById('card-' + d.name);
                    const isOnline = d.status === 'online';
                    if (!card) {
                        card = document.createElement('div');
                        card.id = 'card-' + d.name;
                        grid.appendChild(card);
                    }
                    card.className = `glass rounded-2xl p-6 shadow-lg flex flex-col h-96 transition-all duration-300 ${!isOnline ? 'opacity-50 grayscale' : ''}`;
                    const logs = window.globalState.deviceLogs && window.globalState.deviceLogs[d.name] 
                        ? window.globalState.deviceLogs[d.name].map(l => `<div>${l}</div>`).join('') 
                        : '<div>--- Terminal Logs ---</div>';
                        
                    // Format date to DD-MMMM-YYYY hh:mm:ss
                    let dateStr = 'N/A';
                    if (d.last_seen) {
                        const dObj = new Date(d.last_seen);
                        if (!isNaN(dObj.getTime())) {
                            const day = String(dObj.getDate()).padStart(2, '0');
                            const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                            const month = months[dObj.getMonth()];
                            const year = dObj.getFullYear();
                            const hrs = String(dObj.getHours()).padStart(2, '0');
                            const mins = String(dObj.getMinutes()).padStart(2, '0');
                            const secs = String(dObj.getSeconds()).padStart(2, '0');
                            dateStr = `${day}-${month}-${year} ${hrs}:${mins}:${secs}`;
                        }
                    }

                    card.innerHTML = `
                        <div class="flex justify-between items-start mb-2 shrink-0">
                            <h3 class="text-lg font-bold flex items-center"><i class="fas fa-microchip text-primary mr-2"></i> ${d.name}</h3>
                            <span class="flex items-center text-xs px-2 py-1 rounded-full ${isOnline ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
                                ${(d.status || 'offline').toUpperCase()}
                            </span>
                        </div>
                        <div class="text-xs text-gray-400 mb-2 space-y-1">
                            <div><i class="fas fa-network-wired w-4"></i> IP: ${d.ip_address || 'N/A'}</div>
                            <div><i class="fas fa-wifi w-4"></i> Signal: ${d.rssi ? d.rssi + ' dBm' : 'N/A'}</div>
                            <div><i class="fas fa-thermometer-half w-4"></i> Temp: ${d.temperature ? d.temperature + '°C' : 'N/A'}</div>
                            <div><i class="fas fa-clock w-4"></i> Last seen: ${dateStr}</div>
                        </div>
                        <div class="relative flex-1 mt-1 rounded bg-black overflow-hidden flex flex-col">
                            <div class="absolute top-2 right-4 flex space-x-4 bg-black/60 px-2 py-1 rounded z-10">
                                <button class="text-gray-400 hover:text-white transition group relative" onclick="toggleAutoScroll('${d.name}')">
                                    <i id="icon-scroll-${d.name}" class="fas ${(!window.globalState.autoScroll || window.globalState.autoScroll[d.name] !== false) ? 'fa-lock' : 'fa-unlock'}"></i>
                                    <div class="absolute top-full right-0 mt-2 px-3 py-1.5 text-xs glass rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20 text-gray-800 dark:text-gray-200 font-sans font-semibold">Toggle Auto-scroll</div>
                                </button>
                                <button class="text-gray-400 hover:text-white transition group relative" onclick="clearLogs('${d.name}')">
                                    <i class="fas fa-trash"></i>
                                    <div class="absolute top-full right-0 mt-2 px-3 py-1.5 text-xs glass rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20 text-gray-800 dark:text-gray-200 font-sans font-semibold">Clear Logs</div>
                                </button>
                                <button class="text-gray-400 hover:text-white transition group relative" onclick="copyLogs('${d.name}')">
                                    <i class="fas fa-copy"></i>
                                    <div class="absolute top-full right-0 mt-2 px-3 py-1.5 text-xs glass rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-20 text-gray-800 dark:text-gray-200 font-sans font-semibold">Copy to Clipboard</div>
                                </button>
                            </div>
                            <div class="flex-1 text-green-400 font-mono text-[11px] leading-relaxed p-3 overflow-y-auto" id="term-${d.name}">${logs}</div>
                        </div>
                    `;
                });
            });
        }

        renderDevices();
        if (window.deviceInterval) clearInterval(window.deviceInterval);
        window.deviceInterval = setInterval(renderDevices, 5000);

        // Listen for MQTT log messages
        window.addEventListener('deviceLog', (e) => {
            const { device, text } = e.detail;
            const term = document.getElementById('term-' + device);
            if (term) {
                const line = document.createElement('div');
                line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
                term.appendChild(line);
                if (!window.globalState.autoScroll || window.globalState.autoScroll[device] !== false) {
                    term.scrollTop = term.scrollHeight;
                }
            }
        });
    }

    function initScheduler() {
        const calendarEl = document.getElementById('calendar');
        if (!calendarEl) return;

        const calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'dayGridMonth',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
            },
            height: 'auto',
            dateClick: function (info) {
                window.openScheduleModal(info.dateStr, null);
            },
            eventClick: function (info) {
                window.openScheduleModal(info.event.startStr.split('T')[0], parseInt(info.event.id));
            }
        });

        calendar.render();

        function fetchSchedules() {
            fetch('/api/schedules').then(r => r.json()).then(data => {
                calendar.removeAllEvents();
                data.forEach(s => {
                    const d = new Date(s.play_time);
                    let eventParams = {
                        id: s.id,
                        title: `${s.audio_name} → ${s.device_name}`,
                        backgroundColor: s.repeat !== 'none' ? '#7c3aed' : '#3b82f6'
                    };
                    if (s.repeat === 'weekly') {
                        eventParams.daysOfWeek = [d.getDay()];
                        eventParams.startTime = d.toTimeString().split(' ')[0];
                    } else if (s.repeat === 'daily') {
                        eventParams.startTime = d.toTimeString().split(' ')[0];
                    } else {
                        eventParams.start = d;
                    }
                    calendar.addEvent(eventParams);
                });

                const tbody = document.getElementById('scheduleTableBody');
                if (tbody) {
                    if (data.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-500">No active schedules</td></tr>';
                        return;
                    }
                    tbody.innerHTML = data.map(s => `
                        <tr class="border-b dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/30">
                            <td class="py-3 px-4 font-mono text-primary text-xs">${new Date(s.play_time).toLocaleString()}</td>
                            <td class="py-3 px-4 text-sm">${s.audio_name || 'Unknown'}</td>
                            <td class="py-3 px-4 text-sm">${s.device_name}</td>
                            <td class="py-3 px-4 capitalize text-sm"><span class="px-2 py-1 rounded-full text-xs ${s.repeat !== 'none' ? 'bg-purple-900/30 text-purple-400' : 'bg-blue-900/30 text-blue-400'}">${s.repeat}</span></td>
                            <td class="py-3 px-4 text-right">
                                <button onclick="window.deleteSchedule(${s.id})" class="text-red-400 hover:text-red-600 transition-colors px-2 py-1">
                                    <i class="fas fa-trash-alt"></i>
                                </button>
                            </td>
                        </tr>
                    `).join('');
                }
            });
        }
        fetchSchedules();

        const modal = document.getElementById('scheduleModal');
        const form = document.getElementById('schedulerForm');

        // Populate audio select
        fetch('/api/files').then(r => r.json()).then(files => {
            const select = document.getElementById('audioSelect');
            if (select) {
                if (files.length === 0) {
                    select.innerHTML = '<option value="">-- No audio files uploaded --</option>';
                } else {
                    select.innerHTML = files.map(f => `<option value="${f.id}">${f.original_name}</option>`).join('');
                }
            }
        });

        // Populate device select
        fetch('/api/devices').then(r => r.json()).then(devices => {
            const container = document.getElementById('targetDeviceContainer');
            if (container) {
                let html = `
                    <label class="flex items-center space-x-3 cursor-pointer p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded">
                        <input type="radio" name="targetDevice" value="all" class="text-primary focus:ring-primary h-4 w-4 cursor-pointer" checked>
                        <span class="text-sm text-gray-900 dark:text-gray-200 font-medium">All Devices</span>
                    </label>
                `;
                devices.filter(d => d.name !== 'Web App').forEach(d => {
                    html += `
                        <label class="flex items-center space-x-3 cursor-pointer p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded">
                            <input type="radio" name="targetDevice" value="${d.name}" class="text-primary focus:ring-primary h-4 w-4 cursor-pointer">
                            <span class="text-sm text-gray-900 dark:text-gray-200 font-medium">${d.name}</span>
                        </label>
                    `;
                });
                container.innerHTML = html;
            }
        });

        window.openScheduleModal = function (dateStr, existingId) {
            if (form) form.reset();
            // Reset repeat buttons
            if (typeof setSchedRepeat === 'function') setSchedRepeat('none');
            if (dateStr && document.getElementById('dateSelect')) {
                document.getElementById('dateSelect').value = dateStr;
            }
            if (document.getElementById('timeSelect')) {
                document.getElementById('timeSelect').value = '12:00:00';
            }
            if (document.getElementById('scheduleVolumeSelect')) {
                document.getElementById('scheduleVolumeSelect').value = 70;
                const volVal = document.getElementById('schedVolVal');
                if (volVal) volVal.textContent = '70';
            }
            if (modal) modal.classList.remove('hidden');
        };

        window.closeScheduleModal = function () {
            if (modal) modal.classList.add('hidden');
        };

        if (form) {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const d = document.getElementById('dateSelect').value;
                const t = document.getElementById('timeSelect').value;
                if (!d || !t) {
                    Swal.fire('Error', 'Please select date and time', 'error');
                    return;
                }

                // Ensure seconds are present: HH:MM or HH:MM:SS → always HH:MM:SS
                const parts = t.split(':');
                const timeStr = parts.length >= 3 ? `${parts[0]}:${parts[1]}:${parts[2]}` : `${parts[0]}:${parts[1] || '00'}:00`;
                // Build a LOCAL datetime string (no Z, no UTC offset).
                // The server's APScheduler is configured with Asia/Jayapura timezone,
                // so it correctly interprets naive strings as local time.
                // Using .toISOString() would shift to UTC and schedule 9h early.
                const pad = n => String(n).padStart(2,'0');
                const localStr = `${d}T${timeStr}`;
                const dt = new Date(`${d}T${timeStr}`);

                const audioId = document.getElementById('audioSelect')?.value;
                if (!audioId) {
                    Swal.fire('Error', 'Please upload an audio file first', 'error');
                    return;
                }

                const payload = {
                    audio_id: parseInt(audioId),
                    device_name: document.querySelector('input[name="targetDevice"]:checked')?.value || 'all',
                    play_time: localStr,
                    repeat: document.getElementById('repeatSelect')?.value || 'none',
                    volume: parseInt(document.getElementById('scheduleVolumeSelect')?.value || 70)
                };

                try {
                    const r = await fetch('/api/schedules', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    if (r.ok) {
                        Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Schedule saved!', showConfirmButton: false, timer: 3000 });
                        window.closeScheduleModal();
                        fetchSchedules();
                    } else {
                        const err = await r.json();
                        Swal.fire('Error', err.detail || 'Failed to schedule', 'error');
                    }
                } catch (e) {
                    console.error(e);
                    Swal.fire('Error', 'Network error', 'error');
                }
            });
        }

        window.deleteSchedule = function (id) {
            Swal.fire({
                title: 'Delete schedule?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Yes, delete'
            }).then(res => {
                if (res.isConfirmed) {
                    fetch('/api/schedules/' + id, { method: 'DELETE' }).then(() => fetchSchedules());
                }
            });
        };
    }

    function initConfig() {
        const form = document.getElementById('configForm');
        if (!form) return;

        // Dynamic formats based on type
        const tcType = document.getElementById('cfgTcType');
        const tcFormat = document.getElementById('cfgTcFormat');
        const tcBitrate = document.getElementById('cfgTcBitrate');
        
        function updateTcOptions() {
            if (!tcType || !tcFormat || !tcBitrate) return;
            const isLossy = tcType.value === 'lossy';
            tcFormat.innerHTML = isLossy 
                ? '<option value="mp3">MP3</option><option value="aac">AAC</option><option value="ogg">OGG</option>'
                : '<option value="flac">FLAC</option><option value="wav">WAV</option>';
            tcBitrate.innerHTML = isLossy
                ? '<option value="64k">64 kbps</option><option value="128k">128 kbps</option><option value="192k">192 kbps</option><option value="256k">256 kbps</option><option value="320k">320 kbps</option>'
                : '<option value="16bit">16-bit</option><option value="24bit">24-bit</option>';
        }

        if (tcType) {
            tcType.addEventListener('change', updateTcOptions);
        }

        const tcEnable = document.getElementById('cfgTcEnable');
        const tcOptions = document.getElementById('cfgTcOptions');
        if (tcEnable) {
            tcEnable.addEventListener('change', (e) => {
                if (e.target.checked) tcOptions.classList.remove('hidden');
                else tcOptions.classList.add('hidden');
            });
        }

        fetch('/api/config').then(r => r.json()).then(conf => {
            const elVol = document.getElementById('cfgVol');
            const elTz = document.getElementById('cfgTz');
            const elLang = document.getElementById('cfgLang');

            if (elVol) {
                elVol.value = conf.default_volume || 50;
                const elVolVal = document.getElementById('cfgVolVal');
                if (elVolVal) elVolVal.innerText = elVol.value + '%';
            }
            if (elTz) elTz.value = conf.timezone || 'Asia/Jayapura';
            if (elLang) elLang.value = conf.language || 'en';
            
            if (tcEnable) {
                tcEnable.checked = conf.transcode_enabled || false;
                if (conf.transcode_enabled) tcOptions.classList.remove('hidden');
                
                if (tcType) tcType.value = conf.transcode_type || 'lossy';
                updateTcOptions();
                if (tcFormat) tcFormat.value = conf.transcode_format || 'mp3';
                if (tcBitrate) tcBitrate.value = conf.transcode_bitrate || '128k';
                
                const tcSampleRate = document.getElementById('cfgTcSampleRate');
                if (tcSampleRate) tcSampleRate.value = conf.transcode_samplerate || '44100';
            }
        });

        const elVol = document.getElementById('cfgVol');
        if (elVol) {
            elVol.addEventListener('input', e => {
                const elVolVal = document.getElementById('cfgVolVal');
                if (elVolVal) elVolVal.innerText = e.target.value + '%';
            });
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData();
            formData.append('default_volume', document.getElementById('cfgVol')?.value || 50);
            formData.append('timezone', document.getElementById('cfgTz')?.value || 'Asia/Jayapura');
            formData.append('language', document.getElementById('cfgLang')?.value || 'en');
            
            if (tcEnable) {
                formData.append('transcode_enabled', tcEnable.checked);
                formData.append('transcode_type', tcType.value);
                formData.append('transcode_format', tcFormat.value);
                formData.append('transcode_bitrate', tcBitrate.value);
                formData.append('transcode_samplerate', document.getElementById('cfgTcSampleRate').value);
            }

            try {
                const r = await fetch('/api/config', { method: 'POST', body: formData });
                if (r.ok) {
                    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'Configuration Saved', showConfirmButton: false, timer: 3000 });
                } else {
                    Swal.fire('Error', 'Failed to save config', 'error');
                }
            } catch (e) {
                console.error(e);
            }
        });
    }

    // ─── Mini Player Controls ─────────────────────────────────────────────────
    if (miniBtnPlay) miniBtnPlay.addEventListener('click', togglePlay);
    const miniBtnStop = document.getElementById('miniBtnStop');
    if (miniBtnStop) miniBtnStop.addEventListener('click', stopPlayback);
    if (miniBtnNext) miniBtnNext.addEventListener('click', playNext);
    if (miniBtnPrev) miniBtnPrev.addEventListener('click', playPrev);

    const miniVolIcon = document.getElementById('miniVolIcon');
    if (miniVolIcon) miniVolIcon.addEventListener('click', toggleMute);

    if (miniVolSlider) {
        miniVolSlider.addEventListener('input', e => {
            if (window.sendspinPlayer && typeof window.sendspinPlayer.setVolume === 'function') {
                window.sendspinPlayer.setVolume(e.target.value / 100.0);
            }
        });
        miniVolSlider.addEventListener('change', e => {
            pushStateChange('volume', { volume: parseInt(e.target.value) });
        });
    }

    // ─── Terminal Controls ────────────────────────────────────────────────────
    window.toggleAutoScroll = function(device) {
        if (!window.globalState.autoScroll) window.globalState.autoScroll = {};
        window.globalState.autoScroll[device] = window.globalState.autoScroll[device] === false ? true : false;
        const icon = document.getElementById('icon-scroll-' + device);
        if (icon) {
            icon.className = window.globalState.autoScroll[device] ? 'fas fa-lock' : 'fas fa-unlock';
        }
    };

    window.clearLogs = function(device) {
        if (window.globalState.deviceLogs && window.globalState.deviceLogs[device]) {
            window.globalState.deviceLogs[device] = [];
        }
        const term = document.getElementById('term-' + device);
        if (term) term.innerHTML = '<div>--- Terminal Logs ---</div>';
    };

    window.copyLogs = function(device) {
        const term = document.getElementById('term-' + device);
        if (term) {
            const text = term.innerText;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(showCopyToast);
            } else {
                // Fallback for non-HTTPS (like local IP)
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = "fixed";  // Avoid scrolling to bottom
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    showCopyToast();
                } catch (err) {
                    console.error('Fallback: Oops, unable to copy', err);
                }
                document.body.removeChild(textArea);
            }
        }
    };
    
    function showCopyToast() {
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: 'Logs copied to clipboard!',
            showConfirmButton: false,
            timer: 2000,
            customClass: { popup: 'glass' },
            background: 'transparent'
        });
    }

    // ─── Modal Upload ──────────────────────────────────────────────────────────
    window.openUploadModal = function() {
        Swal.fire({
            title: 'Upload Music',
            html: `
                <div id="dropZone" class="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-8 mb-4 text-center cursor-pointer hover:border-primary transition-colors bg-white/50 dark:bg-black/30">
                    <i class="fas fa-cloud-upload-alt text-4xl text-primary mb-2"></i>
                    <p class="text-sm text-gray-600 dark:text-gray-400">Drag & drop audio files here<br>or click to browse</p>
                    <p class="text-xs text-gray-500 mt-2">Supported: mp3, wav, flac, aac, ogg</p>
                    <input type="file" id="swalFileInput" multiple class="hidden">
                </div>
                <div id="swalUploadStatus" class="hidden">
                    <div class="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700 mb-2">
                        <div class="bg-primary h-2.5 rounded-full w-0 transition-all duration-300" id="swalUploadBar"></div>
                    </div>
                    <p class="text-xs text-center text-primary" id="swalUploadText">Uploading 0 of 0...</p>
                </div>
            `,
            showConfirmButton: false,
            showCancelButton: true,
            cancelButtonText: 'Close',
            customClass: { popup: 'glass' },
            didOpen: () => {
                const dropZone = document.getElementById('dropZone');
                const fileInput = document.getElementById('swalFileInput');
                const uploadStatus = document.getElementById('swalUploadStatus');
                const uploadBar = document.getElementById('swalUploadBar');
                const uploadText = document.getElementById('swalUploadText');

                dropZone.addEventListener('click', () => fileInput.click());

                ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                    dropZone.addEventListener(eventName, preventDefaults, false);
                });

                function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }

                ['dragenter', 'dragover'].forEach(eventName => {
                    dropZone.addEventListener(eventName, () => dropZone.classList.add('border-primary', 'bg-primary/10'), false);
                });

                ['dragleave', 'drop'].forEach(eventName => {
                    dropZone.addEventListener(eventName, () => dropZone.classList.remove('border-primary', 'bg-primary/10'), false);
                });

                dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files), false);
                fileInput.addEventListener('change', (e) => handleFiles(e.target.files), false);

                async function handleFiles(files) {
                    if (!files || files.length === 0) return;
                    
                    dropZone.classList.add('hidden');
                    uploadStatus.classList.remove('hidden');
                    
                    let uploadedCount = 0;
                    
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        uploadText.innerText = `Uploading ${i + 1} of ${files.length}: ${file.name}`;
                        const formData = new FormData();
                        formData.append('file', file);
                        
                        try {
                            const res = await fetch('/api/upload', { method: 'POST', body: formData });
                            if (res.ok) {
                                uploadedCount++;
                                uploadBar.style.width = `${((i + 1) / files.length) * 100}%`;
                            }
                        } catch (err) {
                            console.error('Upload failed for', file.name, err);
                        }
                    }
                    
                    uploadText.innerText = 'Refreshing playlist...';
                    const newFiles = await (await fetch('/api/files')).json();
                    window.allFiles = newFiles;
                    renderPlaylist(newFiles);
                    updateUIFromState();
                    
                    Swal.close();
                }
            }
        });
    };

    if (miniProgressBarContainer) {
        miniProgressBarContainer.addEventListener('click', (e) => {
            const rect = miniProgressBarContainer.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            if (wavesurfer && wavesurfer.getDuration && wavesurfer.getDuration() > 0) {
                const time = pct * wavesurfer.getDuration();
                if (window.globalState.is_playing) {
                    pushStateChange('seek', { position: time });
                } else {
                    pushStateChange('play', {
                        audio_id: window.globalState.audio_id,
                        volume: window.globalState.volume,
                        position: time
                    });
                }
            }
        });
    }

    // ─── Bootstrap ───────────────────────────────────────────────────────────
    // Load all files first so they're available when state arrives
    fetch('/api/files').then(r => r.json()).then(files => {
        window.allFiles = files;
        // If state arrived before files finished loading, re-apply it now!
        if (window.globalState && window.globalState.audio_id) {
            applyServerState(window.globalState);
        }
    });

    connectWebSocket();
    // Also poll the state once on load (WebSocket also sends state on connect)
    fetch('/api/state').then(r => r.json()).then(state => {
        applyServerState(state);
    });

    initPageScripts(location.pathname);
    updatePlayerVisibility(location.pathname);
});

// ─── Global Helpers (must be outside DOMContentLoaded for onclick= to work) ──
// The scheduler's repeat buttons use onclick="setSchedRepeat('daily')" which
// is called from HTML context — must be a window-level function.
window.setSchedRepeat = function(val) {
    const hidden = document.getElementById('repeatSelect');
    if (hidden) hidden.value = val;
    ['none', 'daily', 'weekly', 'monthly'].forEach(v => {
        const btn = document.getElementById('btnRepeat_' + v);
        if (btn) {
            btn.className = v === val
                ? 'flex-1 py-1.5 rounded-full text-xs font-medium bg-primary text-white'
                : 'flex-1 py-1.5 rounded-full text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600';
        }
    });
};
