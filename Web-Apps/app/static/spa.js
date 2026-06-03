// app/static/spa.js
// COMPLETE REWRITE - fixes SPA audio continuity, cross-client sync, and all known bugs.
document.addEventListener('DOMContentLoaded', () => {

    const mainContent = document.getElementById('spa-content');
    const bottomPlayer = document.getElementById('bottom-player');
    // Single shared audio element - persists across SPA navigation
    const localAudio = document.getElementById('localAudio');

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

    if (localAudio && !window.localAudioEndedListenerAttached) {
        localAudio.addEventListener('ended', () => {
            if (!wavesurferInitialized && window.globalState.is_playing) {
                stopPlayback();
            }
        });
        window.localAudioEndedListenerAttached = true;
    }

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
                    applyServerState(data.state);
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

    // ─── Autoplay Unlock (Browser Policy) ────────────────────────────────────
    // Browsers require a user gesture before playing audio. If the server is
    // already playing when this client connects (new tab/phone), we show a
    // toast asking the user to tap, then seek to the correct position.
    let autoplayBlocked = false;

    function showAutoplaySyncToast() {
        // Remove any existing toast
        const existing = document.getElementById('autoplayToast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'autoplayToast';
        toast.style.cssText = [
            'position:fixed', 'bottom:100px', 'left:50%', 'transform:translateX(-50%)',
            'background:linear-gradient(135deg,#3b82f6,#6366f1)',
            'color:#fff', 'padding:14px 28px', 'border-radius:40px',
            'font-weight:600', 'font-size:15px', 'cursor:pointer',
            'z-index:9999', 'box-shadow:0 8px 32px rgba(99,102,241,0.5)',
            'display:flex', 'align-items:center', 'gap:10px',
            'animation:slideUp 0.3s ease'
        ].join(';');
        toast.innerHTML = '<i class="fas fa-play-circle"></i> Tap to join playback';

        toast.addEventListener('click', () => {
            autoplayBlocked = false;
            toast.remove();
            // Now seek to current position and play
            const state = window.globalState;
            if (state.audio_id && localAudio && localAudio.src) {
                let pos = state.current_position || state.position || 0;
                // Account for time elapsed since state was received
                if (state.is_playing && state.server_time > 0) {
                    const clientNow = Date.now() / 1000;
                    pos = state.position + (clientNow - state.last_updated) * (state.speed || 1.0);
                    pos = Math.max(0, pos);
                }
                localAudio.currentTime = pos;
                localAudio.play().then(() => {
                    if (wavesurfer) {
                        const dur = wavesurfer.getDuration ? wavesurfer.getDuration() : 0;
                        if (dur > 0) wavesurfer.seekTo(Math.min(1, pos / dur));
                        wavesurfer.play().catch(() => {});
                    }
                }).catch(e => console.error('Play after tap:', e));
            }
        });

        document.body.appendChild(toast);
    }

    // ─── State Sync Logic ─────────────────────────────────────────────────────
    /**
     * Core synchronization function.
     * The server sends `position` (at time `last_updated`) and `server_time` (now).
     * We compute: actualPosition = position + (server_time - last_updated) * speed
     * Then we seek the audio to that position and play/pause accordingly.
     */
    function applyServerState(state) {
        const prevAudioId = window.globalState.audio_id;

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

        // Load new audio file if track changed AND not already loading it.
        // currentLoadedAudioId is set by selectSong() before this arrives,
        // so we skip the redundant second load that caused the double-load race.
        const fileObj = window.allFiles.find(f => f.id === state.audio_id);
        if (fileObj && state.audio_id !== currentLoadedAudioId) {
            if (localAudio) {
                localAudio.src = `/audio_files/${encodeURIComponent(fileObj.filename)}`;
                currentLoadedAudioId = state.audio_id;
                // wavesurfer.load() internally manages localAudio.src and load()
                if (wavesurfer) {
                    wavesurfer.load(localAudio.src).catch(e => {
                        if (e.name !== 'AbortError') console.error(e);
                    });
                } else {
                    localAudio.load();
                }
            }
        }

        // Sync volume
        if (localAudio && state.volume !== undefined) {
            localAudio.volume = state.volume / 100.0;
        }

        // Play/Pause with autoplay unlock handling
        if (state.is_playing && state.audio_id) {
            if (localAudio && localAudio.src && !localAudio.src.endsWith(window.location.host + '/')) {

                const tryPlay = () => {
                    const doPlay = () => {
                        if (wavesurfer && wavesurfer.getDuration && wavesurfer.getDuration() > 0) {
                            const duration = wavesurfer.getDuration();
                            if (Math.abs(wavesurfer.getCurrentTime() - actualPosition) > 2.0) {
                                wavesurfer.seekTo(Math.min(1, Math.max(0, actualPosition / duration)));
                            }
                            wavesurfer.play().catch(err => {
                                if (err.name === 'NotAllowedError') { autoplayBlocked = true; showAutoplaySyncToast(); }
                            });
                        } else {
                            if (Math.abs(localAudio.currentTime - actualPosition) > 2.0) {
                                localAudio.currentTime = actualPosition;
                            }
                            localAudio.play().catch(err => {
                                if (err.name === 'NotAllowedError') { autoplayBlocked = true; showAutoplaySyncToast(); }
                            });
                        }
                    };

                    if (delayMs > 0) {
                        if (localAudio && !localAudio.paused) localAudio.pause();
                        if (wavesurfer) wavesurfer.pause();
                        
                        if (wavesurfer && wavesurfer.getDuration && wavesurfer.getDuration() > 0) {
                            wavesurfer.seekTo(Math.min(1, Math.max(0, actualPosition / wavesurfer.getDuration())));
                        } else if (localAudio) {
                            localAudio.currentTime = actualPosition;
                        }

                        if (window.playTimeoutId) { clearTimeout(window.playTimeoutId); }
                        window.playTimeoutId = setTimeout(() => {
                            window.playTimeoutId = null;
                            if (window.globalState.is_playing) doPlay();
                        }, delayMs);
                    } else {
                        if (window.playTimeoutId) { clearTimeout(window.playTimeoutId); window.playTimeoutId = null; }
                        
                        if (localAudio && !localAudio.paused) {
                            const currentPos = wavesurfer && wavesurfer.getDuration && wavesurfer.getDuration() > 0 ? wavesurfer.getCurrentTime() : localAudio.currentTime;
                            if (Math.abs(currentPos - actualPosition) > 3.0) {
                                if (wavesurfer && wavesurfer.getDuration && wavesurfer.getDuration() > 0) {
                                    wavesurfer.seekTo(Math.min(1, Math.max(0, actualPosition / wavesurfer.getDuration())));
                                } else if (localAudio) {
                                    localAudio.currentTime = actualPosition;
                                }
                            }
                        } else {
                            doPlay();
                        }
                    }
                };

                if (localAudio.readyState < 2) {
                    localAudio.addEventListener('canplay', tryPlay, { once: true });
                } else {
                    tryPlay();
                }

            }
        } else if (!state.is_playing) {
            if (window.playTimeoutId) { clearTimeout(window.playTimeoutId); window.playTimeoutId = null; }
            if (localAudio && !localAudio.paused) localAudio.pause();
            if (wavesurfer) wavesurfer.pause();
            // Remove autoplay toast when stopped
            const toast = document.getElementById('autoplayToast');
            if (toast) toast.remove();
            autoplayBlocked = false;
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

    // ─── API Commands ─────────────────────────────────────────────────────────
    function getTargetDevice() {
        const deviceSelect = document.getElementById('deviceSelect');
        return deviceSelect ? deviceSelect.value : 'all';
    }

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
        if (localAudio) {
            localAudio.src = audioSrc;
            // Let wavesurfer.load() drive the loading if available;
            // it internally calls load() on the media element.
            if (wavesurfer) {
                wavesurfer.load(audioSrc).catch(e => {
                    if (e.name !== 'AbortError') console.error(e);
                });
            } else {
                localAudio.load();
            }
        }

        // Tell server to broadcast play command (ESP32 + other web clients)
        pushStateChange('play', {
            audio_id: id,
            volume: window.globalState.volume,
            position: 0
        });
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

        if (typeof WaveSurfer === 'undefined') {
            console.error("WaveSurfer not loaded!");
            return;
        }

        // Move the persistent container into the current DOM slot
        container.innerHTML = '';
        container.appendChild(globalWaveformContainer);

        // Only create WaveSurfer once
        if (wavesurferInitialized) {
            // Re-attach events to the refreshed dashboard DOM
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
            media: localAudio  // link to the persistent audio element
        });

        // If audio is already loaded (e.g. user navigated away and back)
        if (localAudio && localAudio.src && !localAudio.src.endsWith(window.location.host + '/')) {
            wavesurfer.load(localAudio.src).catch(e => {
                if (e.name !== 'AbortError') console.error(e);
            });
        }

        wavesurfer.on('ready', () => {
            const dur = wavesurfer.getDuration();
            const timeTotal = document.getElementById('timeTotal');
            if (timeTotal) timeTotal.innerText = formatTime(dur);
            if (miniTimeTotal) miniTimeTotal.innerText = formatTime(dur);

            // Update duration in the playlist if it was 0
            if (window.globalState.audio_id) {
                const fileObj = window.allFiles.find(f => f.id === window.globalState.audio_id);
                if (fileObj && (!fileObj.duration_sec || fileObj.duration_sec === 0)) {
                    fileObj.duration_sec = dur;
                    const el = document.querySelector(`#playlistContainer > div[data-id="${fileObj.id}"] p`);
                    if (el) el.innerText = formatTime(dur);
                }
            }

            // Seek to synced position when waveform loads
            const syncPos = window.globalState.current_position || window.globalState.position;
            if (syncPos > 0 && dur > 0) {
                wavesurfer.seekTo(Math.min(1, syncPos / dur));
            }
            if (window.globalState.is_playing) {
                wavesurfer.play().catch(() => {});
            }
        });

        wavesurfer.on('audioprocess', (currentTime) => {
            const t = formatTime(currentTime);
            const timeElapsed = document.getElementById('timeElapsed');
            if (timeElapsed) timeElapsed.innerText = t;
            if (miniTimeElapsed) miniTimeElapsed.innerText = t;

            const dur = wavesurfer.getDuration();
            const pct = dur > 0 ? (currentTime / dur) * 100 : 0;
            if (miniProgressOverlay) miniProgressOverlay.style.width = pct + '%';
        });

        wavesurfer.on('finish', stopPlayback);

        _attachDashboardWaveSurferEvents();
    }

    function _attachDashboardWaveSurferEvents() {
        // Re-bind seek interaction each time dashboard loads
        if (!wavesurfer) return;
        wavesurfer.un('interaction');
        wavesurfer.on('interaction', (newPosition) => {
            if (!window.globalState.audio_id) return;
            if (window.globalState.is_playing) {
                pushStateChange('seek', { 
                    position: newPosition,
                    audio_id: window.globalState.audio_id
                });
            } else {
                pushStateChange('play', {
                    audio_id: window.globalState.audio_id,
                    volume: window.globalState.volume,
                    position: newPosition
                });
            }
        });

        // If audio is already loaded, update UI immediately
        if (wavesurfer.getDuration && wavesurfer.getDuration() > 0) {
            const dur = wavesurfer.getDuration();
            const timeTotal = document.getElementById('timeTotal');
            if (timeTotal) timeTotal.innerText = formatTime(dur);
            if (miniTimeTotal) miniTimeTotal.innerText = formatTime(dur);
            
            const timeElapsed = document.getElementById('timeElapsed');
            const currentT = wavesurfer.getCurrentTime();
            if (timeElapsed) timeElapsed.innerText = formatTime(currentT);
            if (miniTimeElapsed) miniTimeElapsed.innerText = formatTime(currentT);
        }
    }

    // ─── Page Scripts ─────────────────────────────────────────────────────────
    window.initPageScripts = function (url) {
        if (url === '/' || url === '') initDashboard();
        else if (url === '/devices') initDevices();
        else if (url === '/scheduler') initScheduler();
        else if (url === '/config') initConfig();
    };

    function initDashboard() {
        initWaveSurfer();

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
                if (localAudio) localAudio.volume = e.target.value / 100.0;
            });
            volSlider.addEventListener('change', e => {
                pushStateChange('volume', { volume: e.target.value });
            });
        }

        const speedSelect = document.getElementById('speedSelect');
        if (speedSelect) {
            speedSelect.value = window.globalState.speed.toString();
            speedSelect.addEventListener('change', e => {
                pushStateChange('speed', { speed: e.target.value });
            });
        }

        // Load device list into deviceSelect
        fetch('/api/devices').then(r => r.json()).then(devices => {
            const deviceSelect = document.getElementById('deviceSelect');
            if (deviceSelect) {
                let html = '<option value="all">All Devices</option>';
                devices.filter(d => d.name !== 'Web App').forEach(d => {
                    html += `<option value="${d.name}">${d.name}</option>`;
                });
                deviceSelect.innerHTML = html;
            }
        });

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
            const select = document.getElementById('targetDeviceSelect');
            if (select) {
                let html = '<option value="all">All Devices</option>';
                devices.filter(d => d.name !== 'Web App').forEach(d => { html += `<option value="${d.name}">${d.name}</option>`; });
                select.innerHTML = html;
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
                    device_name: document.getElementById('targetDeviceSelect')?.value || 'all',
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
            if (localAudio) localAudio.volume = e.target.value / 100.0;
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
                    <input type="file" id="swalFileInput" multiple accept=".mp3,.wav,.flac,.aac,.ogg" class="hidden">
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
