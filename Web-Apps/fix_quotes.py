import sys

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'r') as f:
    content = f.read()

# Fix window.selectSong argument
old_select = '''    window.selectSong = function(fileObj) {
        pushStateChange('play', { 
            audio_id: fileObj.id, 
            volume: window.globalState.volume, 
            position: 0 
        });
    };'''

new_select = '''    window.selectSong = function(id) {
        pushStateChange('play', { 
            audio_id: id, 
            volume: window.globalState.volume, 
            position: 0 
        });
    };'''
content = content.replace(old_select, new_select)

# Fix playNext/Prev to use ID
content = content.replace('window.selectSong(window.allFiles[0]);', 'window.selectSong(window.allFiles[0].id);')
content = content.replace('window.selectSong(window.allFiles[idx]);', 'window.selectSong(window.allFiles[idx].id);')

# Fix renderPlaylist onclick
old_render = '''<div class="flex items-center space-x-4" onclick='window.selectSong()'>'''
new_render = '''<div class="flex items-center space-x-4" onclick="window.selectSong()">'''
content = content.replace(old_render, new_render)
# Fallback in case the replacement string is slightly different
old_render2 = '''<div class="flex items-center space-x-4" onclick='window.selectSong()'>'''
content = content.replace(old_render2, new_render)

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/static/spa.js', 'w') as f:
    f.write(content)

