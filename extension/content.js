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
                lastSentState = nuevoEstado;
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
