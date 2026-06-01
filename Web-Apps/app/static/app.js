document.addEventListener('DOMContentLoaded', () => {
    const themeToggleBtn = document.getElementById('themeToggle');
    const html = document.documentElement;

    // Apply saved theme
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        html.classList.add('dark');
    } else {
        html.classList.remove('dark');
    }

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            html.classList.toggle('dark');
            localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light';
        });
    }

    // Mobile menu: toggle sidebar as an overlay drawer using only CSS classes.
    // The sidebar is ALWAYS in the DOM; on mobile it's hidden via translateX(-100%).
    // We use 'mobile-open' to slide it in. We must NOT use 'hidden' (display:none)
    // because that disables transitions and can't be undone by transform.
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.querySelector('aside#sidebar');
    const overlay = document.getElementById('mobileOverlay');

    function openMobileMenu() {
        if (!sidebar) return;
        sidebar.classList.add('mobile-open');
        if (overlay) overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeMobileMenu() {
        if (!sidebar) return;
        sidebar.classList.remove('mobile-open');
        if (overlay) overlay.classList.add('hidden');
        document.body.style.overflow = '';
    }

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', openMobileMenu);
    }
    if (overlay) {
        overlay.addEventListener('click', closeMobileMenu);
    }

    // Close menu when a spa-link is clicked on mobile
    document.body.addEventListener('click', e => {
        if (e.target.closest('a.spa-link') && window.innerWidth < 768) {
            closeMobileMenu();
        }
    });
});
