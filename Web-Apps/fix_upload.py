import sys

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'r') as f:
    content = f.read()

# Replace upload logic
old_upload = '''        const uploadForm = document.getElementById('uploadForm');
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
        }'''

new_upload = '''        const fileInput = document.getElementById('fileInput');
        if(fileInput) {
            fileInput.addEventListener('change', async () => {
                if(!fileInput.files.length) return;
                const formData = new FormData();
                formData.append('file', fileInput.files[0]);
                
                const uploadStatus = document.getElementById('uploadStatus');
                const uploadBar = document.getElementById('uploadBar');
                
                if(uploadStatus) uploadStatus.classList.remove('hidden');
                if(uploadBar) uploadBar.style.width = '50%';
                
                try {
                    const r = await fetch('/api/upload', { method: 'POST', body: formData });
                    if(r.ok) {
                        if(uploadBar) uploadBar.style.width = '100%';
                        setTimeout(async () => {
                            if(uploadStatus) uploadStatus.classList.add('hidden');
                            if(uploadBar) uploadBar.style.width = '0%';
                            const files = await (await fetch('/api/files')).json();
                            window.allFiles = files;
                            renderPlaylist(files);
                        }, 500);
                    } else {
                        throw new Error('Upload failed');
                    }
                } catch(e) {
                    Swal.fire('Error', e.message, 'error');
                    if(uploadStatus) uploadStatus.classList.add('hidden');
                }
            });
        }'''

content = content.replace(old_upload, new_upload)

# Add WaveSurfer fallback
old_wavesurfer = '''    function initWaveSurfer() {
        const container = document.getElementById('waveformContainer');
        if(!container) return; // Not on dashboard
        if(wavesurfer) return; // Already initialized
        
        wavesurfer = WaveSurfer.create({'''

new_wavesurfer = '''    function initWaveSurfer() {
        const container = document.getElementById('waveformContainer');
        if(!container) return; // Not on dashboard
        if(wavesurfer) return; // Already initialized
        
        if(typeof WaveSurfer === 'undefined') {
            console.error("WaveSurfer is not loaded! Check internet connection.");
            return;
        }
        
        wavesurfer = WaveSurfer.create({'''

content = content.replace(old_wavesurfer, new_wavesurfer)

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'w') as f:
    f.write(content)

