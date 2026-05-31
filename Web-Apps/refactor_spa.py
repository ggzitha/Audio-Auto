import sys

new_spa = '''// app/static/spa.js
document.addEventListener('DOMContentLoaded', () => {

    const mainContent = document.getElementById('spa-content');
    const bottomPlayer = document.getElementById('bottom-player');
    
    // Global State
    window.globalState = {
        audio_id: null,
        is_playing: false,
        position: 0,
        volume: 50,
        speed: 1.0,
        last_updated: 0
    };
    
    window.allFiles = [];
    
    // --- Initialize WaveSurfer ---
    let wavesurfer = null;
    function initWaveSurfer() {
        const container = document.getElementById('waveformContainer');
        if(!container) return; // Not on dashboard
        if(wavesurfer) return; // Already initialized
        
        wavesurfer = WaveSurfer.create({
            container: '#waveformContainer',
            waveColor: '#4b5563', // Tailwind gray-600
            progressColor: '#3b82f6', // Tailwind blue-500
            cursorColor: '#60a5fa', // Tailwind blue-400
            barWidth: 3,
            barRadius: 3,
            cursorWidth: 2,
            height: 64,
            barGap: 3,
            normalize: true
        });

        wavesurfer.on('ready', () => {
            const timeTotal = document.getElementById('timeTotal');
            if(timeTotal) timeTotal.innerText = formatTime(wavesurfer.getDuration());
            
            // Sync to global position if we just loaded it
            if(window.globalState.position > 0) {
                wavesurfer.seekTo(window.globalState.position / wavesurfer.getDuration());
            }
            if(window.globalState.is_playing) {
                wavesurfer.play();
            }
        });
        
        wavesurfer.on('audioprocess', (currentTime) => {
            const timeElapsed = document.getElementById('timeElapsed');
            if(timeElapsed) timeElapsed.innerText = formatTime(currentTime);
            // Also update mini player
            const miniElapsed = document.getElementById('miniTimeElapsed');
            if(miniElapsed) miniElapsed.innerText = formatTime(currentTime);
            
            const pct = (currentTime / wavesurfer.getDuration()) * 100 || 0;
            const miniProgress = document.getElementById('miniProgressOverlay');
            if(miniProgress) miniProgress.style.width = pct + '%';
        });

        // User clicked the waveform to seek
        wavesurfer.on('interaction', (newPosition) => {
            if(!window.globalState.audio_id) return;
            const time = newPosition * wavesurfer.getDuration();
            pushStateChange('seek', { position: time });
        });
        
        wavesurfer.on('finish', playNext);
    }
    
    // --- Helper Functions ---
    function formatTime(secs) {
        if(!secs || isNaN(secs)) return "00:00";
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    
    // --- State Synchronization ---
    function pushStateChange(action, payload) {
        const deviceSelect = document.getElementById('deviceSelect');
        const targetDevice = deviceSelect ? deviceSelect.value : 'all';
        const formData = new FormData();
        formData.append('device_name', targetDevice);
        
        for (const [key, value] of Object.entries(payload)) {
            formData.append(key, value);
        }
        
        fetch(/api/, { method: 'POST', body: formData }).catch(e => console.error(e));
    }
    
    function updateUIFromState() {
        const state = window.globalState;
        
        // Update Mini Player UI
        const miniPlayIcon = document.getElementById('miniPlayIcon');
        if(miniPlayIcon) {
            miniPlayIcon.className = state.is_playing ? "fas fa-pause-circle text-2xl md:text-3xl" : "fas fa-play-circle text-2xl md:text-3xl";
        }
        
        const bigIcon = document.getElementById('playIcon');
        if(bigIcon) {
            bigIcon.className = state.is_playing ? "fas fa-pause text-3xl md:text-4xl" : "fas fa-play text-3xl md:text-4xl";
        }
        
        const miniVolSlider = document.getElementById('miniVolSlider');
        if(miniVolSlider && miniVolSlider.value != state.volume) {
            miniVolSlider.value = state.volume;
        }
        
        // Handle Track Changes
        if(state.audio_id && window.allFiles.length > 0) {
            const fileObj = window.allFiles.find(f => f.id === state.audio_id);
            if(fileObj) {
                // Update text
                const miniSongTitle = document.getElementById('miniSongTitle');
                if(miniSongTitle) miniSongTitle.innerText = fileObj.original_name;
                const bigTitle = document.getElementById('currentSongTitle');
                if(bigTitle) bigTitle.innerText = fileObj.original_name;
                
                // Update WaveSurfer track if changed
                if(wavesurfer) {
                    const currentUrl = wavesurfer.getMediaElement()?.src || '';
                    if(!currentUrl.endsWith(fileObj.filename)) {
                        wavesurfer.load('/audio_files/' + fileObj.filename);
                        // The 'ready' event will handle play/seek sync
                        return; 
                    }
                }
            }
        }
        
        // Handle Play/Pause
        if(wavesurfer && wavesurfer.isReady) {
            if(state.is_playing && !wavesurfer.isPlaying()) {
                // If it's desynced by more than 2 seconds, seek first
                const currentPos = wavesurfer.getCurrentTime();
                if(Math.abs(currentPos - state.position) > 2.0) {
                    wavesurfer.seekTo(state.position / wavesurfer.getDuration());
                }
                wavesurfer.play();
            } else if (!state.is_playing && wavesurfer.isPlaying()) {
                wavesurfer.pause();
                wavesurfer.seekTo(state.position / wavesurfer.getDuration()); // snap to paused position
            }
        }
        
        // Highlight active playlist item
        document.querySelectorAll('#playlistContainer > div').forEach(el => {
            if(parseInt(el.dataset.id) === state.audio_id) {
                el.classList.add('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
            } else {
                el.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-l-4', 'border-primary');
            }
        });
    }

    // --- Global WebSocket ---
    let ws = null;
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(${protocol}///ws);
        
        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                if(data.type === 'log') {
                    const logContainer = document.getElementById('log-' + data.device);
                    if(logContainer) {
                        const entry = document.createElement('div');
                        entry.innerText = data.text;
                        logContainer.appendChild(entry);
                        logContainer.scrollTop = logContainer.scrollHeight;
                    }
                } else if(data.type === 'state') {
                    // Update global state and UI
                    window.globalState = data.state;
                    updateUIFromState();
                }
            } catch(e) { console.error(e); }
        };
        
        ws.onclose = function() {
            setTimeout(connectWebSocket, 3000); // Reconnect
        };
    }

    // Fetch initial global state
    fetch('/api/state').then(r=>r.json()).then(state => {
        window.globalState = state;
        updateUIFromState();
    });

    // --- Player Controls (UI Interactions) ---
    function togglePlay() {
        if(!window.globalState.audio_id && window.allFiles.length > 0) {
            window.selectSong(window.allFiles[0]); // Starts playing automatically
            return;
        }
        if(window.globalState.audio_id) {
            if(window.globalState.is_playing) {
                pushStateChange('stop', {});
            } else {
                const pos = wavesurfer && wavesurfer.isReady ? wavesurfer.getCurrentTime() : window.globalState.position;
                pushStateChange('play', { 
                    audio_id: window.globalState.audio_id, 
                    volume: window.globalState.volume, 
                    position: pos 
                });
            }
        }
    }
    
    function playNext() {
        if(window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => f.id === window.globalState.audio_id);
        idx = (idx + 1) % window.allFiles.length;
        window.selectSong(window.allFiles[idx]);
    }
    
    function playPrev() {
        if(window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => f.id === window.globalState.audio_id);
        idx = (idx - 1 + window.allFiles.length) % window.allFiles.length;
        window.selectSong(window.allFiles[idx]);
    }

    window.selectSong = function(fileObj) {
        pushStateChange('play', { 
            audio_id: fileObj.id, 
            volume: window.globalState.volume, 
            position: 0 
        });
    };

    // Bind Mini Player Controls
    const miniBtnPlay = document.getElementById('miniBtnPlay');
    if(miniBtnPlay) miniBtnPlay.addEventListener('click', togglePlay);
    
    const miniBtnNext = document.getElementById('miniBtnNext');
    if(miniBtnNext) miniBtnNext.addEventListener('click', playNext);
    
    const miniBtnPrev = document.getElementById('miniBtnPrev');
    if(miniBtnPrev) miniBtnPrev.addEventListener('click', playPrev);
    
    const miniVolSlider = document.getElementById('miniVolSlider');
    if(miniVolSlider) {
        miniVolSlider.addEventListener('change', e => {
            pushStateChange('volume', { volume: e.target.value });
        });
    }

    const miniProgressBarContainer = document.getElementById('miniProgressBarContainer');
    if(miniProgressBarContainer) {
        miniProgressBarContainer.addEventListener('click', (e) => {
            if(!wavesurfer || !wavesurfer.isReady) return;
            const rect = miniProgressBarContainer.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            pushStateChange('seek', { position: pos * wavesurfer.getDuration() });
        });
    }

    // --- Routing & Display Logic ---
    function updatePlayerVisibility(url) {
        if(url === '/' || url === '') {
            bottomPlayer.classList.add('hidden'); // hide mini player on dashboard
        } else {
            bottomPlayer.classList.remove('hidden'); // show mini player everywhere else
        }
    }

    window.initPageScripts = function(url) {
        if (url === '/' || url === '') initDashboard();
        else if (url === '/devices') initDevices();
        else if (url === '/scheduler') initScheduler();
        else if (url === '/config') initConfig();
    }
    
    function initDashboard() {
        initWaveSurfer();
        
        const btnPlay = document.getElementById('btnPlay');
        if(btnPlay) {
            // Remove old listeners to prevent duplicates if dashboard is reloaded
            const newBtn = btnPlay.cloneNode(true);
            btnPlay.parentNode.replaceChild(newBtn, btnPlay);
            newBtn.addEventListener('click', togglePlay);
        }
        
        const btnNext = document.getElementById('btnNext');
        if(btnNext) {
            const newBtn = btnNext.cloneNode(true);
            btnNext.parentNode.replaceChild(newBtn, btnNext);
            newBtn.addEventListener('click', playNext);
        }
        
        const btnPrev = document.getElementById('btnPrev');
        if(btnPrev) {
            const newBtn = btnPrev.cloneNode(true);
            btnPrev.parentNode.replaceChild(newBtn, btnPrev);
            newBtn.addEventListener('click', playPrev);
        }

        fetch('/api/files').then(r=>r.json()).then(files => {
            window.allFiles = files;
            renderPlaylist(files);
            // Re-trigger UI update in case global state arrived before files
            updateUIFromState();
        });

        const playlistContainer = document.getElementById('playlistContainer');
        function renderPlaylist(files) {
            if(!playlistContainer) return;
            if(files.length === 0) {
                playlistContainer.innerHTML = '<div class="p-8 text-center text-gray-500">No audio files.</div>';
                return;
            }
            playlistContainer.innerHTML = files.map(f => 
                <div class="flex items-center justify-between px-6 py-4 hover:bg-gray-50 dark:hover:bg-[#253246] transition-colors group cursor-pointer" data-id="">
                    <div class="flex items-center space-x-4" onclick="window.selectSong()">
                        <div class="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                            <i class="fas fa-music"></i>
                        </div>
                        <div>
                            <h4 class="font-semibold text-gray-800 dark:text-gray-200"></h4>
                            <p class="text-xs text-gray-500 mt-1"></p>
                        </div>
                    </div>
                    <div class="flex items-center space-x-3">
                        <button onclick="window.deleteFile()" class="text-red-400 hover:text-red-600 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            ).join('');
            
            updateUIFromState(); // to highlight correct song
        }

        window.deleteFile = function(id) {
            Swal.fire({
                title: 'Delete audio file?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#ef4444',
                confirmButtonText: 'Yes, delete it'
            }).then((result) => {
                if (result.isConfirmed) {
                    fetch('/api/files/' + id, { method: 'DELETE' })
                    .then(r => r.json())
                    .then(res => {
                        window.allFiles = window.allFiles.filter(f => f.id !== id);
                        renderPlaylist(window.allFiles);
                    });
                }
            });
        };
        
        const uploadForm = document.getElementById('uploadForm');
        const fileInput = document.getElementById('audioFile');
        if(uploadForm && fileInput) {
            uploadForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if(!fileInput.files.length) return;
                
                const formData = new FormData();
                formData.append('file', fileInput.files[0]);
                
                const btn = uploadForm.querySelector('button');
                const origHtml = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Uploading...';
                btn.disabled = true;
                
                try {
                    const r = await fetch('/api/upload', { method: 'POST', body: formData });
                    if(r.ok) {
                        const files = await (await fetch('/api/files')).json();
                        window.allFiles = files;
                        renderPlaylist(files);
                        Swal.fire({
                            toast: true,
                            position: 'top-end',
                            icon: 'success',
                            title: 'Upload complete',
                            showConfirmButton: false,
                            timer: 3000
                        });
                        uploadForm.reset();
                    } else {
                        throw new Error('Upload failed');
                    }
                } catch(e) {
                    Swal.fire('Error', e.message, 'error');
                } finally {
                    btn.innerHTML = origHtml;
                    btn.disabled = false;
                }
            });
        }
    }
    
    window.currentIntervals = window.currentIntervals || [];
    window.currentIntervals.forEach(clearInterval);
    window.currentIntervals = [];
    
    function initDevices() {
        const grid = document.getElementById('devicesGrid');
        
        function renderDevices() {
            fetch('/api/devices').then(r=>r.json()).then(devices => {
                devices = devices.filter(d => d.name !== 'Web App');
                if(devices.length === 0) {
                    grid.innerHTML = '<div class="col-span-full text-center py-10 text-gray-500">No devices found.</div>';
                    return;
                }
                devices.forEach(d => {
                    let card = document.getElementById('card-' + d.name);
                    const isOnline = d.status === 'online';
                    if(!card) {
                        card = document.createElement('div');
                        card.id = 'card-' + d.name;
                        card.className = 'glass rounded-2xl p-6 shadow-lg flex flex-col h-96';
                        grid.appendChild(card);
                    }
                    card.innerHTML = 
                        <div class="flex justify-between items-start mb-2 shrink-0">
                            <h3 class="text-lg font-bold flex items-center"><i class="fas fa-microchip text-primary mr-2"></i> </h3>
                            <span class="flex items-center text-xs px-2 py-1 rounded-full ">
                                
                            </span>
                        </div>
                        <div class="text-xs text-gray-400 mb-2 space-y-1">
                            <div><i class="fas fa-network-wired w-4"></i> IP: </div>
                            <div><i class="fas fa-wifi w-4"></i> Signal: </div>
                            <div><i class="fas fa-thermometer-half w-4"></i> Temp: </div>
                        </div>
                        <div class="flex-grow flex flex-col min-h-0 bg-black/50 rounded-lg p-2 font-mono text-xs overflow-hidden mt-2">
                            <div class="text-gray-500 mb-1 border-b border-gray-700 pb-1">--- Terminal Logs ---</div>
                            <div id="log-" class="flex-grow overflow-y-auto text-green-400 break-all space-y-1 pr-1 custom-scrollbar"></div>
                        </div>
                    ;
                });
            });
        }
        
        renderDevices();
        const interval = setInterval(renderDevices, 5000);
        window.currentIntervals.push(interval);
    }
    
    function initScheduler() {
        const form = document.getElementById('schedulerForm');
        
        fetch('/api/files').then(r=>r.json()).then(files => {
            const select = document.getElementById('audioSelect');
            if(select) {
                select.innerHTML = files.map(f => <option value=""></option>).join('');
            }
        });
        
        fetch('/api/devices').then(r=>r.json()).then(devices => {
            const select = document.getElementById('targetDeviceSelect');
            if(select) {
                let html = '<option value="all">All Devices</option>';
                devices.forEach(d => { html += <option value=""></option>; });
                select.innerHTML = html;
            }
        });
        
        if(form) {
            // Flatpickr Time Picker
            flatpickr("#timeInput", {
                enableTime: true,
                noCalendar: true,
                dateFormat: "H:i",
                time_24hr: true
            });

            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const formData = new FormData(form);
                const data = {
                    audio_id: parseInt(formData.get('audio_id')),
                    device_name: formData.get('device_name'),
                    scheduled_time: formData.get('scheduled_time'),
                    repeat: formData.get('repeat')
                };
                
                fetch('/api/schedules', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(data)
                }).then(r => {
                    if(r.ok) {
                        Swal.fire('Success', 'Schedule created', 'success');
                        form.reset();
                        fetchSchedules();
                    } else {
                        Swal.fire('Error', 'Failed to create schedule', 'error');
                    }
                });
            });
        }
        
        fetchSchedules();
        
        function fetchSchedules() {
            const tbody = document.getElementById('scheduleTableBody');
            if(!tbody) return;
            fetch('/api/schedules').then(r=>r.json()).then(schedules => {
                if(schedules.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-500">No active schedules</td></tr>';
                    return;
                }
                tbody.innerHTML = schedules.map(s => 
                    <tr class="border-b dark:border-gray-700/50">
                        <td class="py-3 px-4 font-mono text-primary"></td>
                        <td class="py-3 px-4 capitalize"></td>
                        <td class="py-3 px-4 text-gray-400">ID: </td>
                        <td class="py-3 px-4"></td>
                        <td class="py-3 px-4 text-right">
                            <button onclick="window.deleteSchedule()" class="text-red-400 hover:text-red-600 transition-colors">
                                <i class="fas fa-times"></i>
                            </button>
                        </td>
                    </tr>
                ).join('');
            });
        }
        
        window.deleteSchedule = function(id) {
            Swal.fire({
                title: 'Remove schedule?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#ef4444'
            }).then(result => {
                if(result.isConfirmed) {
                    fetch('/api/schedules/' + id, { method: 'DELETE' }).then(() => {
                        fetchSchedules();
                    });
                }
            });
        };
    }
    
    function initConfig() {
        const configForm = document.getElementById('configForm');
        if(configForm) {
            configForm.addEventListener('submit', (e) => {
                e.preventDefault();
                Swal.fire('Saved', 'Configuration updated', 'success');
            });
        }
    }
    
    // Connect WebSocket
    connectWebSocket();

    // Initial run
    initPageScripts(location.pathname);
    updatePlayerVisibility(location.pathname);
});
'''

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'w') as f:
    f.write(new_spa)
