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

// Aviso de cambio de dominio: omt.godsplan.site → omt.godsplan.dev
(function () {
    var NUEVO = 'omt.godsplan.dev';
    var VIEJO = 'omt.godsplan.site';
    var CLAVE = 'avisoDominioDev';

    // Si alguien todavía abre el link viejo, lo mandamos al nuevo
    if (location.hostname === VIEJO) {
        location.replace('https://' + NUEVO + location.pathname + location.search + location.hash);
        return;
    }

    try { if (localStorage.getItem(CLAVE) === '1') return; } catch (e) {}

    function mostrar() {
        var fondo = document.createElement('div');
        fondo.setAttribute('role', 'dialog');
        fondo.setAttribute('aria-modal', 'true');
        fondo.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,41,.75);backdrop-filter:blur(4px);font-family:inherit;';
        fondo.innerHTML =
            '<div style="max-width:560px;width:100%;background:var(--surface,#fff);color:var(--text,#0f1729);border-radius:20px;padding:32px 28px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35);border:3px solid var(--brand,#4f46e5);">' +
                '<div style="font-size:56px;line-height:1;margin-bottom:12px;">📢</div>' +
                '<h2 style="font-size:28px;font-weight:800;margin:0 0 12px;">¡La página cambió de dirección!</h2>' +
                '<p style="font-size:17px;color:var(--text-2,#4b5567);margin:0 0 18px;">Desde ahora entra siempre por:</p>' +
                '<div style="font-size:30px;font-weight:800;color:var(--brand,#4f46e5);background:var(--brand-soft,#eef0ff);border-radius:14px;padding:14px 10px;margin:0 0 18px;word-break:break-all;">' + NUEVO + '</div>' +
                '<p style="font-size:16px;color:var(--text-2,#4b5567);margin:0 0 24px;">El link anterior (<b>' + VIEJO + '</b>) deja de funcionar el <b>7 de diciembre</b>. Guarda el nuevo en tus favoritos.</p>' +
                '<button type="button" style="font-size:18px;font-weight:700;color:#fff;background:var(--brand,#4f46e5);border:0;border-radius:12px;padding:14px 28px;cursor:pointer;">Entendido, ya lo guardé</button>' +
            '</div>';
        fondo.querySelector('button').addEventListener('click', function () {
            try { localStorage.setItem(CLAVE, '1'); } catch (e) {}
            fondo.remove();
        });
        document.body.appendChild(fondo);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mostrar);
    else mostrar();
})();
