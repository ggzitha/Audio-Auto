// app/static/spa.js
document.addEventListener('DOMContentLoaded', () => {

    const mainContent = document.getElementById('spa-content');
    const bottomPlayer = document.getElementById('bottom-player');
    
    // Core Audio Engine in base.html
    const localAudio = document.getElementById('localAudio');
    window.allFiles = [];
    let currentAudioId = null;
    let isPlaying = false;

    // Mini Player Elements (always in DOM)
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
    
    // --- Routing & Display Logic ---
    function updatePlayerVisibility(url) {
        if(url === '/' || url === '') {
            bottomPlayer.classList.add('hidden'); // hide mini player on dashboard
        } else {
            bottomPlayer.classList.remove('hidden'); // show mini player everywhere else
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
                if (newContent) {
                    mainContent.innerHTML = newContent.innerHTML;
                    applyLanguage();
                    initPageScripts(url);
                    updatePlayerVisibility(url);
                }
            });
    }
    
    window.addEventListener('popstate', () => {
        const url = location.pathname;
        loadPage(url);
    });
    
    document.body.addEventListener('click', e => {
        if (e.target.closest('a.spa-link')) {
            e.preventDefault();
            const url = e.target.closest('a.spa-link').getAttribute('href');
            navigateTo(url);
        }
    });

    // --- Audio Logic ---
    function formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // Called when a song is chosen
    window.selectSong = function(fileObj) {
        if(!fileObj) return;
        currentAudioId = fileObj.id;
        localAudio.src = '/audio_files/' + fileObj.filename;
        
        // Update mini player
        miniSongTitle.innerText = fileObj.original_name;
        
        // Update big player if on dashboard
        const bigTitle = document.getElementById('currentSongTitle');
        if(bigTitle) bigTitle.innerText = fileObj.original_name;
    };
    
    window.setPlayState = function(playing) {
        isPlaying = playing;
        
        const deviceSelect = document.getElementById('deviceSelect');
        const targetDevice = deviceSelect ? deviceSelect.value : 'all';
        const volSlider = document.getElementById('miniVolSlider');
        const currentVol = volSlider ? volSlider.value : 50;

        if(playing) {
            localAudio.play();
            miniPlayIcon.className = "fas fa-pause-circle text-2xl md:text-3xl";
            const bigIcon = document.getElementById('playIcon');
            if(bigIcon) bigIcon.className = "fas fa-pause text-3xl md:text-4xl";
            
            // Trigger remote ESP32 Play
            if (currentAudioId) {
                const formData = new FormData();
                formData.append('device_name', targetDevice);
                formData.append('audio_id', currentAudioId);
                formData.append('volume', currentVol);
                formData.append('position', localAudio.currentTime);
                fetch('/api/play', { method: 'POST', body: formData }).catch(e => console.error(e));
            }
        } else {
            localAudio.pause();
            miniPlayIcon.className = "fas fa-play-circle text-2xl md:text-3xl";
            const bigIcon = document.getElementById('playIcon');
            if(bigIcon) bigIcon.className = "fas fa-play text-3xl md:text-4xl";
            
            // Trigger remote ESP32 Stop
            const formData = new FormData();
            formData.append('device_name', targetDevice);
            fetch('/api/stop', { method: 'POST', body: formData }).catch(e => console.error(e));
        }
    };
    
    function togglePlay() {
        if(!currentAudioId && window.allFiles.length > 0) {
            window.selectSong(window.allFiles[0]);
        }
        if(currentAudioId) {
            window.setPlayState(!isPlaying);
        }
    }
    
    function playNext() {
        if(window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => f.id === currentAudioId);
        idx = (idx + 1) % window.allFiles.length;
        window.selectSong(window.allFiles[idx]);
        window.setPlayState(true);
    }
    
    function playPrev() {
        if(window.allFiles.length === 0) return;
        let idx = window.allFiles.findIndex(f => f.id === currentAudioId);
        idx = (idx - 1 + window.allFiles.length) % window.allFiles.length;
        window.selectSong(window.allFiles[idx]);
        window.setPlayState(true);
    }

    localAudio.addEventListener('loadedmetadata', () => {
        miniTimeTotal.innerText = formatTime(localAudio.duration);
        const bigTimeTotal = document.getElementById('timeTotal');
        if(bigTimeTotal) bigTimeTotal.innerText = formatTime(localAudio.duration);
    });
    
    localAudio.addEventListener('timeupdate', () => {
        const t = formatTime(localAudio.currentTime);
        const pct = (localAudio.currentTime / localAudio.duration) * 100 || 0;
        
        miniTimeElapsed.innerText = t;
        miniProgressOverlay.style.width = pct + '%';
        
        const bigTimeElapsed = document.getElementById('timeElapsed');
        if(bigTimeElapsed) {
            bigTimeElapsed.innerText = t;
            document.getElementById('progressOverlay').style.width = pct + '%';
        }
    });
    
    // Seeking functionality
    miniProgressBarContainer.addEventListener('click', (e) => {
        if(!localAudio.duration) return;
        const rect = miniProgressBarContainer.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        localAudio.currentTime = pos * localAudio.duration;
        
        if (isPlaying) {
            const deviceSelect = document.getElementById('deviceSelect');
            const targetDevice = deviceSelect ? deviceSelect.value : 'all';
            const formData = new FormData();
            formData.append('device_name', targetDevice);
            formData.append('position', localAudio.currentTime);
            fetch('/api/seek', { method: 'POST', body: formData }).catch(e => console.error(e));
        }
    });
    
    localAudio.addEventListener('ended', playNext);
    
    miniBtnPlay.addEventListener('click', togglePlay);
    miniBtnNext.addEventListener('click', playNext);
    miniBtnPrev.addEventListener('click', playPrev);
    
    miniVolSlider.addEventListener('input', e => { 
        localAudio.volume = e.target.value/100; 
    });
    
    miniVolSlider.addEventListener('change', e => {
        const deviceSelect = document.getElementById('deviceSelect');
        const targetDevice = deviceSelect ? deviceSelect.value : 'all';
        const formData = new FormData();
        formData.append('device_name', targetDevice);
        formData.append('volume', e.target.value);
        fetch('/api/volume', { method: 'POST', body: formData }).catch(e => console.error(e));
    });

    // --- Page Specific Logic ---
    window.initPageScripts = function(url) {
        if (url === '/' || url === '') initDashboard();
        else if (url === '/devices') initDevices();
        else if (url === '/scheduler') initScheduler();
        else if (url === '/config') initConfig();
    }
    
    function initDashboard() {
        // Fetch files
        fetch('/api/files').then(r=>r.json()).then(files => {
            window.allFiles = files;
            renderPlaylist(files);
        });

        const playlistContainer = document.getElementById('playlistContainer');
        function renderPlaylist(files) {
            if(!playlistContainer) return;
            if(files.length === 0) {
                playlistContainer.innerHTML = '<div class="p-8 text-center text-gray-500">No audio files.</div>';
                return;
            }
            playlistContainer.innerHTML = files.map(f => `
                <div class="flex items-center justify-between px-6 py-4 hover:bg-gray-50 dark:hover:bg-[#253246] transition-colors group cursor-pointer" data-id="${f.id}">
                    <div class="flex flex-col overflow-hidden" onclick="window.selectSong(window.allFiles.find(x=>x.id==${f.id})); window.setPlayState(true);">
                        <span class="font-medium text-gray-900 dark:text-white truncate">${f.original_name}</span>
                        <span class="text-xs text-gray-500">${new Date(f.upload_time).toLocaleDateString()}</span>
                    </div>
                    <div class="flex items-center space-x-4 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="window.deleteFile(${f.id})" class="text-red-400 hover:text-red-600"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `).join('');
        }
        
        window.deleteFile = function(id) {
            Swal.fire({
                title: 'Delete file?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Yes, delete it'
            }).then(res => {
                if(res.isConfirmed) {
                    fetch('/api/files/' + id, {method: 'DELETE'}).then(()=>{
                        fetch('/api/files').then(r=>r.json()).then(files => {
                            window.allFiles = files;
                            renderPlaylist(files);
                        });
                    });
                }
            });
        };
        
        // Attach Big Player UI events
        const btnPlay = document.getElementById('btnPlay');
        if(btnPlay) {
            btnPlay.addEventListener('click', togglePlay);
            document.getElementById('btnNext').addEventListener('click', playNext);
            document.getElementById('btnPrev').addEventListener('click', playPrev);
            document.getElementById('volSlider').addEventListener('input', e => { localAudio.volume = e.target.value/100; });
            
            // Sync big player UI with current state upon load
            if(currentAudioId) {
                document.getElementById('currentSongTitle').innerText = window.allFiles.find(f=>f.id===currentAudioId)?.original_name || 'Unknown';
            }
            if(isPlaying) {
                document.getElementById('playIcon').className = "fas fa-pause text-3xl md:text-4xl";
            }
            
            // Waveform visual
            const waveformBars = document.getElementById('waveformBars');
            waveformBars.innerHTML = '';
            for(let i=0; i<80; i++) {
                const h = Math.random() * 80 + 20;
                waveformBars.innerHTML += `<div class="flex-1 bg-gray-400 dark:bg-gray-500 rounded-t-sm" style="height:${h}%; opacity:${Math.random()*0.5+0.5}"></div>`;
            }
            
            // Seeking for big player
            const waveformContainer = document.getElementById('waveformContainer');
            if (waveformContainer) {
                waveformContainer.addEventListener('click', (e) => {
                    if(!localAudio.duration) return;
                    const rect = waveformContainer.getBoundingClientRect();
                    const pos = (e.clientX - rect.left) / rect.width;
                    localAudio.currentTime = pos * localAudio.duration;
                });
            }
        }
        
        // Upload logic
        const fileInput = document.getElementById('fileInput');
        if(fileInput) {
            fileInput.addEventListener('change', () => {
                if(!fileInput.files.length) return;
                const formData = new FormData();
                formData.append('file', fileInput.files[0]);
                document.getElementById('uploadStatus').classList.remove('hidden');
                document.getElementById('uploadBar').style.width = '50%';
                
                fetch('/api/upload', { method: 'POST', body: formData }).then(r=>r.json()).then(()=>{
                    document.getElementById('uploadBar').style.width = '100%';
                    setTimeout(() => {
                        document.getElementById('uploadStatus').classList.add('hidden');
                        document.getElementById('uploadBar').style.width = '0%';
                        fetch('/api/files').then(r=>r.json()).then(files => {
                            window.allFiles = files;
                            renderPlaylist(files);
                        });
                    }, 1000);
                });
            });
        }
    }
    
    function initDevices() {
        const grid = document.getElementById('deviceGrid');
        if(!grid) return;
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
                    card.innerHTML = `
                        <div class="flex justify-between items-start mb-2 shrink-0">
                            <h3 class="text-lg font-bold flex items-center"><i class="fas fa-microchip text-primary mr-2"></i> ${d.name}</h3>
                            <span class="flex items-center text-xs px-2 py-1 rounded-full ${isOnline ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}">
                                ${d.status.toUpperCase()}
                            </span>
                        </div>
                        <div class="text-xs text-gray-400 mb-2 space-y-1">
                            <div><i class="fas fa-network-wired w-4"></i> IP: ${d.ip_address || 'N/A'}</div>
                            <div><i class="fas fa-wifi w-4"></i> Signal: ${d.rssi ? d.rssi + ' dBm' : 'N/A'}</div>
                            <div><i class="fas fa-thermometer-half w-4"></i> Temp: ${d.temperature ? d.temperature + '°C' : 'N/A'}</div>
                        </div>
                        <div class="flex-1 bg-black text-green-400 font-mono text-xs p-2 rounded overflow-y-auto" id="term-${d.name}">
                            ${document.getElementById('term-'+d.name) ? document.getElementById('term-'+d.name).innerHTML : '<div>--- Terminal Logs ---</div>'}
                        </div>
                    `;
                });
            });
        }
        renderDevices();
    }
    
    function initScheduler() {
        const calendarEl = document.getElementById('calendar');
        if(!calendarEl) return;
        
        let allSchedules = [];
        
        const calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'dayGridMonth',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
            },
            height: 'auto',
            dateClick: function(info) {
                openScheduleModal(info.dateStr, null);
            },
            eventClick: function(info) {
                openScheduleModal(info.event.startStr.split('T')[0], parseInt(info.event.id));
            }
        });
        
        calendar.render();
        
        function fetchSchedules() {
            fetch('/api/schedules').then(r=>r.json()).then(data => {
                allSchedules = data;
                calendar.removeAllEvents();
                data.forEach(s => {
                    const d = new Date(s.play_time);
                    let eventParams = {
                        id: s.id,
                        title: s.device_name,
                        backgroundColor: '#3b82f6'
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
            });
        }
        fetchSchedules();
        
        // Modal Logic
        const modal = document.getElementById('scheduleModal');
        const modalContent = document.getElementById('scheduleModalContent');
        const devSelect = document.getElementById('schedDevice');
        const audSelect = document.getElementById('schedAudio');
        const schedId = document.getElementById('schedId');
        const schedDate = document.getElementById('schedDate');
        const schedTime = document.getElementById('schedTime');
        const btnDelete = document.getElementById('btnDeleteSched');
        // Initialize clock timepicker
        if (window.flatpickr) {
            flatpickr('#schedTime', {
                enableTime: true,
                noCalendar: true,
                dateFormat: "H:i:S",
                enableSeconds: true,
                time_24hr: true
            });
        }
        
        window.setRecur = function(type) {
            document.getElementById('schedRecur').value = type;
            ['none', 'daily', 'weekly', 'monthly'].forEach(t => {
                const btn = document.getElementById('btnRecur' + t.charAt(0).toUpperCase() + t.slice(1));
                if(t === type) {
                    btn.className = "flex-1 py-1.5 rounded-full text-xs font-medium bg-primary text-white transition-colors";
                } else {
                    btn.className = "flex-1 py-1.5 rounded-full text-xs font-medium bg-[#1a202c] border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors";
                }
            });
        };

        window.openScheduleModal = function(dateStr, id) {
            fetch('/api/devices').then(r=>r.json()).then(devs => {
                devSelect.innerHTML = '<option value="all">All Devices</option>' + devs.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
            });
            fetch('/api/files').then(r=>r.json()).then(files => {
                audSelect.innerHTML = files.map(f => `<option value="${f.id}">${f.original_name}</option>`).join('');
            });
            
            schedDate.value = dateStr;
            
            if(id) {
                const s = allSchedules.find(x=>x.id===id);
                schedId.value = id;
                btnDelete.classList.remove('hidden');
                setTimeout(() => {
                    devSelect.value = s.device_name;
                    audSelect.value = s.audio_id;
                    const d = new Date(s.play_time);
                    const hh = d.getHours().toString().padStart(2, '0');
                    const mm = d.getMinutes().toString().padStart(2, '0');
                    const ss = d.getSeconds().toString().padStart(2, '0');
                    const timeStr = `${hh}:${mm}:${ss}`;
                    const fp = document.getElementById('schedTime')._flatpickr;
                    if (fp) fp.setDate(timeStr);
                    else schedTime.value = timeStr;
                    window.setRecur(s.repeat);
                }, 100);
            } else {
                schedId.value = '';
                btnDelete.classList.add('hidden');
                const fp = document.getElementById('schedTime')._flatpickr;
                if (fp) fp.setDate('12:00:00');
                else schedTime.value = '12:00:00';
                window.setRecur('none');
            }
            
            modal.classList.remove('hidden');
            setTimeout(() => {
                modal.classList.remove('opacity-0');
                modalContent.classList.remove('scale-95');
            }, 10);
        };
        
        window.closeScheduleModal = function() {
            modal.classList.add('opacity-0');
            modalContent.classList.add('scale-95');
            setTimeout(() => modal.classList.add('hidden'), 300);
        };
        
        window.saveSchedule = function(e) {
            e.preventDefault();
            const timeVal = schedTime.value || '12:00:00';
            const dt = new Date(`${schedDate.value}T${timeVal}`);
            const rType = document.getElementById('schedRecur').value;

            const data = {
                device_name: devSelect.value,
                audio_id: parseInt(audSelect.value),
                play_time: dt.toISOString(),
                repeat: rType,
                volume: 50
            };
            const id = schedId.value;
            fetch(id ? `/api/schedules/${id}` : '/api/schedules', {
                method: id ? 'PUT' : 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(data)
            }).then(() => {
                closeScheduleModal();
                fetchSchedules();
            });
        };
        
        window.deleteSchedule = function() {
            if(schedId.value) {
                fetch(`/api/schedules/${schedId.value}`, {method: 'DELETE'}).then(()=>{
                    closeScheduleModal();
                    fetchSchedules();
                });
            }
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
    
    // Initial run
    initPageScripts(location.pathname);
    updatePlayerVisibility(location.pathname);
});
