// Popup de la extensión: muestra en vivo los tiempos del asesor
firebase.initializeApp({
    apiKey: "AIzaSyBKYconuZXn53Eb4EJFsHj4rYaO0eK6liQ",
    authDomain: "tratocom-d38e7.firebaseapp.com",
    projectId: "tratocom-d38e7"
});
const db = firebase.firestore();

let relojIntervalo = null;
let sesionActual = null;
let limites = { bano: 15, comida: 30 };
let unsubs = [];

const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const dashboardView = $('dashboard-view');
const inputId = $('agenteId');

const ESTADOS = {
    bath: { titulo: 'En el sanitario' },
    food: { titulo: 'En comida' },
    quality: { titulo: 'En calidad' }
};

function mostrarVista(vista) {
    loginView.classList.toggle('hidden', vista !== 'login');
    dashboardView.classList.toggle('hidden', vista !== 'dashboard');
}

function fmt(seg) {
    if (isNaN(seg) || seg < 0) seg = 0;
    const m = Math.floor(seg / 60).toString().padStart(2, '0');
    const s = (seg % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function fechaISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['agenteId'], (result) => {
        if (result.agenteId) {
            mostrarVista('dashboard');
            arrancar(result.agenteId);
        } else {
            mostrarVista('login');
            inputId.focus();
        }
    });
});

function guardar() {
    const id = inputId.value.trim().toUpperCase();
    if (!id) return;
    $('login-error').classList.add('hidden');
    db.collection('operadores').doc(id).get().then((snap) => {
        if (!snap.exists) {
            $('login-error').textContent = 'Ese ID no está registrado. Revísalo con tu supervisor.';
            $('login-error').classList.remove('hidden');
            return;
        }
        chrome.storage.local.set({ agenteId: id }, () => { mostrarVista('dashboard'); arrancar(id); });
    }).catch(() => {
        // Sin conexión: guardamos igual para no bloquear al asesor
        chrome.storage.local.set({ agenteId: id }, () => { mostrarVista('dashboard'); arrancar(id); });
    });
}
$('btnGuardar').addEventListener('click', guardar);
inputId.addEventListener('keydown', (e) => { if (e.key === 'Enter') guardar(); });

$('btnLogout').addEventListener('click', () => {
    chrome.storage.local.remove(['agenteId'], () => {
        if (relojIntervalo) clearInterval(relojIntervalo);
        unsubs.forEach((u) => u()); unsubs = [];
        inputId.value = '';
        $('welcome-text').textContent = 'Tracker de pausas';
        $('welcome-sub').textContent = 'Touchpoint · Adherencia';
        mostrarVista('login');
    });
});

function arrancar(agenteId) {
    $('welcome-text').textContent = 'ID ' + agenteId;
    $('welcome-sub').textContent = 'Sincronizando…';

    let limOperador = {};
    let limGlobal = { bano: 15, comida: 30 };
    const recalcularLimites = () => {
        limites = { bano: limOperador.bano || limGlobal.bano || 15, comida: limOperador.comida || limGlobal.comida || 30 };
        $('lim-bath').textContent = `/ ${limites.bano}m`;
        $('lim-food').textContent = `/ ${limites.comida}m`;
        dibujar();
    };

    unsubs.push(db.collection('operadores').doc(agenteId).onSnapshot((snap) => {
        if (snap.exists) {
            const d = snap.data();
            $('welcome-text').textContent = d.nombreCorto || d.nombre || ('ID ' + agenteId);
            $('welcome-sub').textContent = 'ID ' + agenteId + (d.horarios && d.horarios.turno ? ' · ' + d.horarios.turno : '');
            limOperador = d.limites || {};
            recalcularLimites();
        }
    }));

    unsubs.push(db.collection('config').doc('global').onSnapshot((snap) => {
        if (snap.exists && snap.data().limites) { limGlobal = snap.data().limites; recalcularLimites(); }
    }));

    const hoy = new Date().toLocaleDateString();
    unsubs.push(db.collection('sesiones_activas').doc(agenteId).onSnapshot((snap) => {
        const vacia = { tiemposAcumulados: { bath: 0, food: 0, quality: 0 }, estadoActivo: null };
        if (snap.exists) {
            const data = snap.data();
            sesionActual = (data.fecha === hoy || data.fecha === fechaISO()) ? data : vacia;
            if (!sesionActual.tiemposAcumulados) sesionActual.tiemposAcumulados = vacia.tiemposAcumulados;
        } else {
            sesionActual = vacia;
        }
        $('sync').classList.remove('off');
        $('sync-text').textContent = 'En vivo';
        dibujar();
    }, () => {
        $('sync').classList.add('off');
        $('sync-text').textContent = 'Sin conexión';
    }));

    if (relojIntervalo) clearInterval(relojIntervalo);
    relojIntervalo = setInterval(dibujar, 1000);
}

function dibujar() {
    if (!sesionActual) return;
    const ahora = Date.now();
    const activo = sesionActual.estadoActivo;

    // Estado actual
    const status = $('status');
    if (ESTADOS[activo]) {
        status.dataset.state = activo;
        const fuera = !!sesionActual.desconectadoEn;
        $('status-label').textContent = fuera ? 'Fuera de Touchpoint · sigue contando' : 'En pausa';
        $('status-title').textContent = fuera ? (sesionActual.motivoDesconexion === 'expulsion' ? 'Desconectado por exceder' : 'Saliste de Touchpoint') : ESTADOS[activo].titulo;
        status.style.background = fuera ? 'var(--danger-soft)' : '';
        status.style.color = fuera ? 'var(--danger)' : '';
        $('status-timer').classList.remove('hidden');
        const enCurso = sesionActual.tiempoInicioEstado ? Math.floor((ahora - sesionActual.tiempoInicioEstado) / 1000) : 0;
        $('status-timer').textContent = fmt(enCurso);
    } else {
        status.dataset.state = 'work';
        status.style.background = ''; status.style.color = '';
        $('status-label').textContent = 'Estado';
        $('status-title').textContent = 'Trabajando';
        $('status-timer').classList.add('hidden');
    }

    ['bath', 'food', 'quality'].forEach((estado) => {
        let seg = sesionActual.tiemposAcumulados[estado] || 0;
        if (activo === estado && sesionActual.tiempoInicioEstado) seg += Math.floor((ahora - sesionActual.tiempoInicioEstado) / 1000);
        $(`time-${estado}`).textContent = fmt(seg);

        const row = $(`box-${estado}`);
        row.classList.toggle('active', activo === estado);
        if (estado === 'quality') return;

        const limSeg = (estado === 'bath' ? limites.bano : limites.comida) * 60;
        const pct = Math.min(100, (seg / limSeg) * 100);
        $(`bar-${estado}`).style.width = pct + '%';
        row.classList.remove('over', 'warn');
        if (seg >= limSeg) {
            row.classList.add('over');
            $(`foot-${estado}`).textContent = 'Excedido por ' + fmt(seg - limSeg);
        } else {
            if (pct > 85) row.classList.add('warn');
            $(`foot-${estado}`).textContent = 'Quedan ' + fmt(limSeg - seg);
        }
    });
}

// =====================================================================
// DIAGNÓSTICO: ¿la extensión está conectada y funcionando?
// content.js guarda "diag" cada 30 s y background.js guarda "sync"
// =====================================================================
const hace = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'hace ' + s + ' s';
    const m = Math.round(s / 60);
    return m < 60 ? 'hace ' + m + ' min' : 'hace ' + Math.round(m / 60) + ' h';
};

function pintarDiagnostico() {
    chrome.storage.local.get(['agenteId', 'diag', 'sync'], ({ agenteId, diag, sync }) => {
        const fresco = diag && (Date.now() - diag.ts) < 75000;
        const checks = [
            { ok: !!agenteId, t: 'ID configurado', s: agenteId ? 'ID ' + agenteId : 'Escribe tu ID arriba' },
            { ok: fresco, t: 'Touchpoint abierto en Chrome', s: fresco ? 'Visto ' + hace(diag.ts) : (diag ? 'Última vez ' + hace(diag.ts) + '. Abre o recarga Touchpoint.' : 'Abre Touchpoint en esta ventana de Chrome.') },
            { ok: fresco && diag.touchpoint, t: 'Sesión de Touchpoint detectada', s: fresco && diag.touchpoint ? ('Estado: ' + (diag.estadoTP || '—')) : 'Inicia sesión en Touchpoint.' },
            { ok: fresco && diag.botonSalida, t: 'Botón de cerrar sesión encontrado', s: fresco && diag.botonSalida ? 'La desconexión automática puede funcionar' : 'Sin esto no se puede desconectar por tiempo. Avisa a tu supervisor.' },
            { ok: !!(sync && sync.ok && Date.now() - sync.ts < 180000), wait: !sync, t: 'Conexión con la base de datos',
              s: !sync ? 'Aún no se ha enviado nada' : (sync.ok ? 'Último envío ' + hace(sync.ts) : (sync.detalle || 'Error') + ' · ' + hace(sync.ts)) }
        ];
        $('diag-list').innerHTML = checks.map(c => `
            <div class="check ${c.ok ? 'ok' : (c.wait ? 'wait' : 'bad')}">
                <span class="ic">${c.ok ? '✓' : (c.wait ? '…' : '!')}</span>
                <div><div class="t">${c.t}</div><div class="s">${c.s}</div></div>
            </div>`).join('');

        const fallas = checks.filter(c => !c.ok);
        const chip = $('conn-chip');
        chip.classList.remove('hidden', 'ok', 'warn', 'bad');
        if (!fallas.length) { chip.classList.add('ok'); $('conn-text').textContent = 'Conectada'; }
        else if (!fresco || !diag.touchpoint) { chip.classList.add('bad'); $('conn-text').textContent = 'Desconectada'; }
        else { chip.classList.add('warn'); $('conn-text').textContent = 'Revisar'; }
        // Si algo falla, el detalle se abre solo
        if (fallas.length) $('diag-box').open = true;
    });
}
pintarDiagnostico();
setInterval(pintarDiagnostico, 5000);
chrome.storage.onChanged.addListener((cambios) => { if (cambios.diag || cambios.sync || cambios.agenteId) pintarDiagnostico(); });
