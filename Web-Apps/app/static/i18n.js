const translations = {
    en: {
        dashboard: "Dashboard",
        scheduler: "Scheduler",
        devices: "Devices",
        config: "Configuration",
        help: "Help",
        realtime_player: "Realtime Player",
        play: "Play",
        stop: "Stop",
        seek: "Seek",
        volume: "Volume",
        upload_music: "Upload Audio",
        add_schedule: "Add Schedule",
        device: "Device",
        time: "Time",
        status: "Status"
    },
    id: {
        dashboard: "Beranda",
        scheduler: "Jadwal",
        devices: "Perangkat",
        config: "Konfigurasi",
        help: "Bantuan",
        realtime_player: "Pemutar Langsung",
        play: "Mainkan",
        stop: "Hentikan",
        seek: "Cari",
        volume: "Volume",
        upload_music: "Unggah Audio",
        add_schedule: "Tambah Jadwal",
        device: "Perangkat",
        time: "Waktu",
        status: "Status"
    }
};

let currentLang = localStorage.getItem('lang') || 'en';

function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if(translations[currentLang][key]) {
            el.innerText = translations[currentLang][key];
        }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if(translations[currentLang][key]) {
            el.setAttribute('placeholder', translations[currentLang][key]);
        }
    });
    const langBtn = document.getElementById('langToggle');
    if(langBtn) langBtn.innerText = currentLang.toUpperCase();
}

document.addEventListener('DOMContentLoaded', () => {
    applyLanguage();
    const langBtn = document.getElementById('langToggle');
    if(langBtn) {
        langBtn.addEventListener('click', () => {
            currentLang = currentLang === 'en' ? 'id' : 'en';
            localStorage.setItem('lang', currentLang);
            applyLanguage();
        });
    }
});
