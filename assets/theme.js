// Tema claro / oscuro compartido. Se carga en el <head> para evitar parpadeo.
(function () {
    var root = document.documentElement;
    try {
        var t = localStorage.getItem('theme');
        if (t === 'dark' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            root.classList.add('dark');
        }
    } catch (e) {}

    function syncIcons() {
        var dark = root.classList.contains('dark');
        document.querySelectorAll('[data-theme-icon]').forEach(function (i) {
            i.className = dark ? 'ph-bold ph-sun' : 'ph-bold ph-moon';
        });
    }

    window.toggleTheme = function () {
        var dark = root.classList.toggle('dark');
        try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
        syncIcons();
    };

    document.addEventListener('DOMContentLoaded', syncIcons);
})();

// Configuración de Tailwind (se lee cuando carga el CDN)
window.tailwind = window.tailwind || {};
window.tailwind.config = {
    darkMode: 'class',
    theme: { extend: { fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] } } }
};
