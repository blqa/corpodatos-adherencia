const VERSION = chrome.runtime.getManifest().version;
console.log("🛡️ Tracker v" + VERSION + " inyectado en TouchPoint.");

// undefined (y no null): así el primer estado, aunque sea "Disponible", SÍ se envía
// y queda registrada la primera conexión del día.
let lastSentState;
let isLoggingOut = false;
let logoutForzado = false; // la extensión lo está sacando: no registrar como salida manual
let observerReference = null;
let observedElement = null;

// Selector del botón "Cerrar sesión" (TouchPoint nuevo: <li ng-click="Logout()"> dentro del menú de Configuración)
const LOGOUT_SELECTOR = 'li[ng-click*="Logout"], .gadget.logout';

function findLogoutButton() {
    return document.querySelector(LOGOUT_SELECTOR);
}

// --- ESCUCHAR ÓRDENES DEL CEREBRO (EXPULSIÓN POR TIEMPO) ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'FORZAR_LOGOUT') {
        console.warn("⏱️ ¡Tiempo excedido! Forzando desconexión...");
        performRemoteLogout();
    }
});

// --- CONFIRMAR EL MODAL DE "¿SEGURO QUE QUIERES SALIR?" (si aparece) ---
function confirmarModal() {
    let intentos = 0;
    const timer = setInterval(() => {
        intentos++;
        const okButton =
            document.querySelector('button[ng-click*="buttons.ok"]') ||
            document.querySelector('.modal-footer .btn-primary') ||
            document.querySelector('.modal .btn-primary') ||
            document.querySelector('.btn.btn-primary');
        if (okButton) {
            console.log("✅ Confirmando cierre de sesión:", okButton);
            okButton.click();
            clearInterval(timer);
        } else if (intentos >= 10) {
            // 5 segundos sin modal: probablemente TouchPoint cerró sin pedir confirmación
            clearInterval(timer);
        }
    }, 500);
}

// --- FUNCIÓN DE LOGOUT FORZADO ---
function performRemoteLogout() {
    isLoggingOut = true;
    logoutForzado = true;
    let logoutBtn = findLogoutButton();

    if (!logoutBtn) {
        // Plan B: abrir el menú de Configuración para que se dibuje la opción y reintentar
        const settings = document.querySelector('.gadget.Settings .ui-next-gadget.settings, .ui-next-gadget.settings');
        if (settings) {
            console.warn("Logout no estaba en el DOM, abriendo menú de Configuración...");
            settings.click();
            setTimeout(() => {
                const btn = findLogoutButton();
                if (btn) { btn.click(); confirmarModal(); }
                else console.error("No se encontró 'Cerrar sesión' en TouchPoint (ni abriendo el menú).");
            }, 500);
        } else {
            console.error("No se encontró el botón de logout ni el menú de Configuración en TouchPoint.");
        }
        return;
    }

    logoutBtn.click();
    confirmarModal();
}

// --- COMUNICACIÓN CON EL CEREBRO DE LA EXTENSIÓN ---
function updateStatus(nuevoEstado) {
    if (isLoggingOut && nuevoEstado !== 'SALIR') return;
    if (nuevoEstado === lastSentState) return;

    chrome.storage.local.get(['agenteId'], function(result) {
        const agenteIdentificador = result.agenteId;

        if (agenteIdentificador && agenteIdentificador !== "") {
            try {
                if (nuevoEstado === 'SALIR') {
                    chrome.runtime.sendMessage({ action: 'SALIR', agenteId: agenteIdentificador });
                } else {
                    console.log("📡 Estado detectado:", nuevoEstado);
                    chrome.runtime.sendMessage({ action: 'CAMBIAR', agenteId: agenteIdentificador, estado: nuevoEstado });
                }
                const habiaEstado = lastSentState !== undefined;
                lastSentState = nuevoEstado;
                if (habiaEstado) revisarDespues(nuevoEstado);
                setTimeout(enviarPulso, 500);
            } catch (e) {
                console.error("Error enviando estado al background:", e);
            }
        } else {
            console.warn("⚠️ Tracker: No se ha configurado un ID en el Popup de la extensión.");
        }
    });
}

// --- OBSERVER DEL ESTADO (se vuelve a enganchar si TouchPoint redibuja el elemento) ---
function attachObserver() {
    const statusGadget = document.querySelector('.gadget.status');
    if (!statusGadget || statusGadget === observedElement) return;

    if (observerReference) observerReference.disconnect();
    observedElement = statusGadget;

    analyzeState(statusGadget);
    observerReference = new MutationObserver(() => {
        if (isLoggingOut) return;
        analyzeState(statusGadget);
    });
    observerReference.observe(statusGadget, { attributes: true, attributeFilter: ['tooltip', 'class'] });
    console.log("👀 Observando el estado de TouchPoint.");
}

const initObserver = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(initObserver); return; }
    attachObserver();
    // Red de seguridad: relee el estado aunque el observer no haya disparado
    if (observedElement && !isLoggingOut) analyzeState(observedElement);
}, 3000);

// --- ANALIZADOR DE ESTADOS ---
function analyzeState(element) {
    if (isLoggingOut) return;
    if (!chrome.runtime?.id) return;

    const tooltip = (element.getAttribute('tooltip') || "").toUpperCase();
    const classes = (element.className || "").toLowerCase();

    // Primero los estados específicos (el tooltip trae el nombre del estado + el tiempo)
    if (tooltip.includes('COMIDA') || tooltip.includes('LUNCH')) { updateStatus('food'); return; }
    if (tooltip.includes('REPOSO') || tooltip.includes('BAÑO') || tooltip.includes('SANITARIO') || tooltip.includes('PERSONAL')) { updateStatus('bath'); return; }
    if (tooltip.includes('CALIDAD') || tooltip.includes('QUALITY') || tooltip.includes('FEEDBACK') || tooltip.includes('COACHING')) { updateStatus('quality'); return; }

    if (classes.includes('available') || tooltip.includes('AVAILABLE') ||
        (tooltip.includes('DISPONIBLE') && !tooltip.includes('NO DISPONIBLE'))) { updateStatus(null); return; }
    if (!classes.includes('pending') && (tooltip.includes('RELEASED') || tooltip.includes('NO LISTO'))) { updateStatus(null); }
}

// --- DETECTOR DE LOGOUT MANUAL (el agente se sale por su cuenta) ---
document.addEventListener('click', (e) => {
    if (e.target.closest(LOGOUT_SELECTOR)) {
        if (logoutForzado) return;
        isLoggingOut = true;
        lastSentState = null;
        updateStatus('SALIR');
    }
}, true);

// --- DIAGNÓSTICO Y PULSO ---
// Cada 30 s revisa que todo esté bien y avisa al background, que lo guarda en Firebase
// (como máximo 1 vez por minuto si nada cambia). El popup y la web lo muestran.
function diagnostico() {
    const status = document.querySelector('.gadget.status');
    const tooltip = (status?.getAttribute('tooltip') || '').trim();
    let estado = lastSentState === undefined ? null : lastSentState;
    if (estado === 'SALIR' || !status) estado = 'sin_sesion';
    return {
        touchpoint: !!status,
        botonSalida: !!(document.querySelector(LOGOUT_SELECTOR) || document.querySelector('.ui-next-gadget.settings')),
        estadoTP: tooltip.split(' - ')[0].trim(),
        estado: estado || 'trabajando',
        host: location.host,
        version: VERSION,
        ts: Date.now()
    };
}

function enviarPulso() {
    if (!chrome.runtime?.id) return; // la extensión se recargó: este script ya no sirve
    const diag = diagnostico();
    chrome.storage.local.get(['agenteId'], (r) => {
        diag.agenteId = r.agenteId || null;
        chrome.storage.local.set({ diag });
        if (r.agenteId) {
            try { chrome.runtime.sendMessage({ action: 'PULSO', agenteId: r.agenteId, diag }).catch(() => {}); } catch (e) {}
        }
    });
}
setTimeout(enviarPulso, 2500);
setInterval(enviarPulso, 30000);

// =====================================================================
// TURNOS DE COMIDA Y BAÑO
// - Comida: solo 1 a la vez. Puedes salir si el que está comiendo ya
//   regresó o le quedan 5 minutos o menos.
// - Baño: máximo 2 a la vez. Si ya hay 1, se pregunta "¿aún así deseas ir?".
// Se intercepta el clic en el motivo de "No listo" de Touchpoint antes de
// que Touchpoint lo reciba; se consulta quién está fuera y, si se puede,
// se deja pasar el clic.
// =====================================================================
const PALABRAS = {
    food: ['COMIDA', 'LUNCH'],
    bath: ['REPOSO', 'BAÑO', 'BANO', 'SANITARIO', 'PERSONAL'],
    quality: ['CALIDAD', 'QUALITY', 'FEEDBACK', 'COACHING']
};
let clicPermitido = null;     // el elemento al que ya se le dio permiso
let ultimoPermiso = { cat: null, ts: 0 };

function categoriaDeTexto(txt) {
    const t = (txt || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40 || /\d:\d\d/.test(t)) return null; // texto largo o con cronómetro: no es una opción del menú
    for (const cat of Object.keys(PALABRAS)) if (PALABRAS[cat].some(p => t.includes(p))) return cat;
    return null;
}

function opcionClicada(target) {
    let el = target;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
        if (el.id === 'tracker-turnos') return null;
        const cat = categoriaDeTexto(el.innerText || el.textContent);
        if (cat) return { el, cat };
        if (el.matches && el.matches('li, a, button, [ng-click], [role="menuitem"], [role="option"]')) break;
    }
    return null;
}

function horaCorta(ms) { return new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function minutos(seg) { const m = Math.max(0, Math.ceil(seg / 60)); return m === 1 ? '1 minuto' : m + ' minutos'; }
function lista(nombres) { return nombres.length <= 1 ? (nombres[0] || '') : nombres.slice(0, -1).join(', ') + ' y ' + nombres[nombres.length - 1]; }

function pedirOcupacion() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['agenteId'], (r) => {
            try {
                chrome.runtime.sendMessage({ action: 'OCUPACION', agenteId: r.agenteId || null }, (resp) => {
                    if (chrome.runtime.lastError || !resp) resolve(null); else resolve(resp);
                });
            } catch (e) { resolve(null); }
            setTimeout(() => resolve(null), 6000); // sin respuesta: no bloquear
        });
    });
}

// Decide qué hacer: { permitir } | { bloquear, titulo, texto } | { preguntar, titulo, texto }
const TXT = {
    food: { icono: '🍽️', lugar: 'comiendo', ir: 'Sí, ir a comer', lleno: 'Todavía no puedes salir a comer' },
    bath: { icono: '🚻', lugar: 'en el baño', ir: 'Sí, ir al baño', lleno: 'El baño está lleno' },
    quality: { icono: '🎧', lugar: 'en calidad', ir: 'Sí, continuar', lleno: 'Calidad está llena' }
};
function evaluar(cat, oc) {
    if (!oc || !oc.max || !oc.fuera) return { permitir: true };
    const max = oc.max[cat] || 0, fuera = oc.fuera[cat] || [], x = TXT[cat];
    if (!max || !fuera.length) return { permitir: true };
    const detalle = (p) => cat === 'food'
        ? `<b>${p.nombre}</b> salió a comer a las <b>${horaCorta(p.inicio)}</b> y le faltan <b>${minutos(p.restanSeg)}</b> para regresar`
        : `<b>${p.nombre}</b> está ${x.lugar} desde las ${horaCorta(p.inicio)}`;
    if (fuera.length >= max) {
        let texto = fuera.length === 1 ? detalle(fuera[0]) + '.' : `Ya hay ${fuera.length} personas ${x.lugar}:<br>• ` + fuera.map(detalle).join('<br>• ');
        texto += `<br><br>Solo se permite${max === 1 ? '' : 'n'} ${max} a la vez. `;
        texto += cat === 'food' ? `Puedes irte a comer cuando regrese ${max === 1 ? '' : 'alguno '}o le queden ${oc.margenComidaMin} minutos o menos de comida.` : 'Espera a que regrese alguno.';
        return { bloquear: true, icono: x.icono, titulo: x.lleno, texto };
    }
    return { preguntar: true, icono: x.icono, titulo: '¿Aún así deseas ir?', ir: x.ir,
        texto: 'Toma en cuenta que ' + fuera.map(detalle).join(' y ') + '.' };
}

function mostrarAviso({ icono, titulo, texto, preguntar, ir }) {
    return new Promise((resolve) => {
        document.getElementById('tracker-turnos')?.remove();
        const host = document.createElement('div');
        host.id = 'tracker-turnos';
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
        const sh = host.attachShadow({ mode: 'open' });
        sh.innerHTML = `
            <style>
                .fondo{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(3px);display:grid;place-items:center;font-family:Inter,Segoe UI,Arial,sans-serif;animation:f .15s ease}
                .caja{width:min(440px,calc(100vw - 32px));background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.35);padding:26px 26px 20px;color:#0f172a;animation:s .18s ease}
                .ico{font-size:34px;line-height:1;margin-bottom:12px}
                h2{margin:0 0 10px;font-size:19px;font-weight:700}
                p{margin:0;font-size:14.5px;line-height:1.55;color:#334155}
                b{color:#0f172a}
                .bot{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
                button{font:inherit;font-size:14px;font-weight:600;border-radius:10px;padding:10px 18px;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#0f172a}
                button.pri{background:#4f46e5;border-color:#4f46e5;color:#fff}
                button:hover{filter:brightness(.95)}
                @keyframes f{from{opacity:0}} @keyframes s{from{transform:translateY(8px) scale(.98);opacity:0}}
            </style>
            <div class="fondo"><div class="caja" role="dialog" aria-modal="true">
                <div class="ico">${icono || '⚠️'}</div><h2>${titulo}</h2><p>${texto}</p>
                <div class="bot">${preguntar ? `<button data-r="no">Cancelar</button><button class="pri" data-r="si">${ir || 'Sí, continuar'}</button>` : '<button class="pri" data-r="no">Entendido</button>'}</div>
            </div></div>`;
        sh.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { host.remove(); resolve(b.dataset.r === 'si'); }));
        document.documentElement.appendChild(host);
        sh.querySelector('button.pri').focus();
    });
}

function interceptar(e) {
    if (!chrome.runtime?.id || isLoggingOut) return;
    const op = opcionClicada(e.target);
    if (!op) return;
    if (clicPermitido === op.el) { clicPermitido = null; return; } // es el clic que ya autorizamos
    if (op.cat === lastSentState) return;                          // ya está en esa pausa
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.type !== 'click') return;                                // solo el clic decide (mousedown/pointerdown solo se frenan)
    console.log('🛑 Tracker: revisando si puede salir a', op.cat);
    pedirOcupacion().then(async (oc) => {
        const d = evaluar(op.cat, oc);
        let seguir = !!d.permitir;
        if (d.bloquear) await mostrarAviso(d);
        if (d.preguntar) seguir = await mostrarAviso(d);
        if (!seguir) return;
        ultimoPermiso = { cat: op.cat, ts: Date.now() };
        clicPermitido = op.el;
        op.el.click();
        setTimeout(() => { if (clicPermitido === op.el) clicPermitido = null; }, 1000);
    });
}
['pointerdown', 'mousedown', 'click'].forEach(t => window.addEventListener(t, (e) => {
    // El pointerdown/mousedown del clic ya autorizado debe pasar también
    if (e.type !== 'click' && clicPermitido) return;
    interceptar(e);
}, true));

// Red de seguridad: si Touchpoint cambió a comida/baño sin pasar por la revisión
// (por ejemplo con otro botón), se revisa y se avisa, y queda registrado para el supervisor.
function revisarDespues(cat) {
    if (cat !== 'food' && cat !== 'bath') return;
    if (ultimoPermiso.cat === cat && Date.now() - ultimoPermiso.ts < 15000) return;
    pedirOcupacion().then((oc) => {
        const d = evaluar(cat, oc);
        if (!d.bloquear || lastSentState !== cat) return;
        mostrarAviso({ ...d, titulo: d.titulo + ' — regresa a Disponible', texto: d.texto + '<br><br><b>Quedó registrado para tu supervisor.</b>' });
        chrome.storage.local.get(['agenteId'], (r) => {
            if (r.agenteId) try { chrome.runtime.sendMessage({ action: 'PAUSA_NO_PERMITIDA', agenteId: r.agenteId, estado: cat }); } catch (e) {}
        });
    });
}
