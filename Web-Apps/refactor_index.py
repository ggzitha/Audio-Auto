import sys
with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/templates/index.html', 'r') as f:
    content = f.read()

old_waveform = '''        <!-- Waveform / Progress -->
        <div class="mb-8 relative group cursor-pointer" id="waveformContainer">
            <div class="flex items-end space-x-[2px] h-12 md:h-16 w-full overflow-hidden" id="waveformBars"></div>
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono">
                <span id="timeElapsed">00:00</span>
                <span id="timeTotal">00:00</span>
            </div>
            <div id="progressOverlay" class="absolute top-0 left-0 h-12 md:h-16 bg-primary opacity-30 pointer-events-none transition-all duration-75" style="width: 0%;"></div>
        </div>'''

new_waveform = '''        <!-- Waveform / Progress -->
        <div class="mb-8 relative group cursor-pointer w-full">
            <div id="waveformContainer" class="w-full"></div>
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono px-1">
                <span id="timeElapsed">00:00</span>
                <span id="timeTotal">00:00</span>
            </div>
        </div>'''

content = content.replace(old_waveform, new_waveform)

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/templates/index.html', 'w') as f:
    f.write(content)
