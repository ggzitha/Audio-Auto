import sys

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'r') as f:
    content = f.read()

old_code = '''const currentUrl = wavesurfer.getMediaElement()?.src || '';
                    if(!currentUrl.endsWith(fileObj.filename)) {'''

new_code = '''const currentUrl = (wavesurfer.getMediaElement && wavesurfer.getMediaElement()) ? wavesurfer.getMediaElement().src : (wavesurfer.media ? wavesurfer.media.src : '');
                    if(!currentUrl || !currentUrl.endsWith(fileObj.filename)) {'''

content = content.replace(old_code, new_code)

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'w') as f:
    f.write(content)

