import sys
with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/templates/base.html', 'r') as f:
    content = f.read()

content = content.replace('</body>', '''
    <script src="https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.min.js"></script>
</body>''')

content = content.replace('<script src="/static/spa.js"></script>', '<script src="/static/spa.js?v={{ cache_buster }}"></script>')

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/templates/base.html', 'w') as f:
    f.write(content)
