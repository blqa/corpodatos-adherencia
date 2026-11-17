// =====================================================================
// background.js v1.2 (Manifest V3)
// - Firestore por REST (sin librerías)
// - Registra pausas, primera conexión, salidas y expulsiones
// - Envía un "pulso" para que la web sepa si la extensión está conectada
// =====================================================================

const firebaseConfig = {
    apiKey: "AIzaSyBKYconuZXn53Eb4EJFsHj4rYaO0eK6liQ",
    projectId: "tratocom-d38e7"
};
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
const ALARMA = "tiempo_agotado_";
const MAPEO_LIMITES = { 'bath': 'bano', 'food': 'comida', 'quality': 'calidad' };
const VERSION = chrome.runtime.getManifest().version;
const PULSO_MIN_MS = 60000; // como máximo una escritura de pulso por minuto si nada cambia

// =====================================================================
// 1. FECHAS
// =====================================================================
const fechaHoy = () => new Date().toLocaleDateString();
const fechaISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0]; };
// La web del asesor guarda la fecha en formato ISO y la extensión en formato local: ambas cuentan como "hoy"
const esDeHoy = (f) => f === fechaHoy() || f === fechaISO();

// =====================================================================
// 2. HELPERS DE FIRESTORE (REST)
// =====================================================================
function parseFirestore(doc) {
    if (!doc || !doc.fields) return null;
    let obj = {};
    for (let [k, v] of Object.entries(doc.fields)) {
        if ('stringValue' in v) obj[k] = v.stringValue;
        else if ('integerValue' in v) obj[k] = parseInt(v.integerValue);
        else if ('doubleValue' in v) obj[k] = parseFloat(v.doubleValue);
        else if ('booleanValue' in v) obj[k] = v.booleanValue;
        else if ('nullValue' in v) obj[k] = null;
        else if ('timestampValue' in v) obj[k] = new Date(v.timestampValue).getTime();
        else if ('mapValue' in v) obj[k] = parseFirestore({ fields: v.mapValue.fields || {} }) || {};
    }
    return obj;
}

function toFirestore(obj) {
    if (obj === null || obj === undefined) return { nullValue: null };
    if (typeof obj === 'string') return { stringValue: obj };
    if (typeof obj === 'number') return Number.isInteger(obj) ? { integerValue: obj.toString() } : { doubleValue: obj };
    if (typeof obj === 'boolean') return { booleanValue: obj };
    if (typeof obj === 'object') {
        if (obj._isTimestamp) return { timestampValue: obj.value || new Date().toISOString() };
        let fields = {};
        for (let [k, v] of Object.entries(obj)) { fields[k] = toFirestore(v); }
        return { mapValue: { fields } };
    }
}

// Guarda en storage si la última comunicación con la base salió bien (lo muestra el popup)
async function registrarSync(ok, detalle = '') {
    try { await chrome.storage.local.set({ sync: { ok, ts: Date.now(), detalle } }); } catch (e) {}
}

async function api(url, opts) {
    try {
        const res = await fetch(url, opts);
        if (res.status === 404) { await registrarSync(true); return { ok: true, status: 404 }; }
        if (!res.ok) {
            const detalle = res.status === 403 ? 'Permiso denegado (reglas de Firestore)' : `Error ${res.status}`;
            await registrarSync(false, detalle);
            console.error('Firestore', res.status, await res.text());
            return { ok: false, status: res.status };
        }
        await registrarSync(true);
        return { ok: true, status: res.status, res };
    } catch (e) {
        await registrarSync(false, 'Sin conexión a internet');
        return { ok: false, status: 0 };
    }
}

async function getDoc(collection, id) {
    const r = await api(`${BASE_URL}/${collection}/${id}?key=${firebaseConfig.apiKey}`);
    if (!r.ok) return { exists: false, error: true, data: () => null };
    if (r.status === 404) return { exists: false, data: () => null };
    const json = await r.res.json();
    return { exists: true, data: () => parseFirestore(json) };
}

async function setDoc(collection, id, data) {
    const payload = { fields: {} };
    for (let [k, v] of Object.entries(data)) payload.fields[k] = toFirestore(v);
    return api(`${BASE_URL}/${collection}/${id}?key=${firebaseConfig.apiKey}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
}

async function addDoc(collection, data) {
    const payload = { fields: {} };
    for (let [k, v] of Object.entries(data)) payload.fields[k] = toFirestore(v);
    return api(`${BASE_URL}/${collection}?key=${firebaseConfig.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
}

// =====================================================================
// 3. PESTAÑAS
// =====================================================================
async function guardarTab(agenteId, tabId) {
    const { tabsActivas = {} } = await chrome.storage.session.get('tabsActivas');
    if (tabsActivas[agenteId] === tabId) return;
    tabsActivas[agenteId] = tabId;
    await chrome.storage.session.set({ tabsActivas });
}
async function obtenerTab(agenteId) {
    const { tabsActivas = {} } = await chrome.storage.session.get('tabsActivas');
    return tabsActivas[agenteId];
}
async function borrarTab(agenteId) {
    const { tabsActivas = {} } = await chrome.storage.session.get('tabsActivas');
    delete tabsActivas[agenteId];
    await chrome.storage.session.set({ tabsActivas });
}
async function buscarAgentePorTab(tabId) {
    const { tabsActivas = {} } = await chrome.storage.session.get('tabsActivas');
    return Object.keys(tabsActivas).find(k => tabsActivas[k] === tabId);
}

// =====================================================================
// 4. MENSAJES, COLA Y ALARMAS
// =====================================================================
const cerrojos = {};
function procesarEnOrden(agenteId, nuevoEstado, razon = "NORMAL") {
    if (!cerrojos[agenteId]) cerrojos[agenteId] = Promise.resolve();
    cerrojos[agenteId] = cerrojos[agenteId]
        .then(() => actualizarBD(agenteId, nuevoEstado, razon))
        .catch(e => console.error("Error en fila de guardado:", e));
}

chrome.runtime.onMessage.addListener((req, sender) => {
    if (req.action === 'CAMBIAR') {
        if (sender.tab) guardarTab(req.agenteId, sender.tab.id);
        procesarEnOrden(req.agenteId, req.estado, 'NORMAL');
    } else if (req.action === 'SALIR') {
        chrome.alarms.clear(ALARMA + req.agenteId);
        procesarEnOrden(req.agenteId, null, 'LOGOUT_MANUAL');
        enviarPulso(req.agenteId, { touchpoint: false, botonSalida: false, estado: 'sin_sesion', estadoTP: 'Cerró sesión' }, true);
    } else if (req.action === 'PULSO') {
        if (sender.tab) guardarTab(req.agenteId, sender.tab.id);
        enviarPulso(req.agenteId, req.diag || {});
    }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    const agenteId = await buscarAgentePorTab(tabId);
    if (agenteId) {
        chrome.alarms.clear(ALARMA + agenteId);
        procesarEnOrden(agenteId, null, 'LOGOUT_MANUAL');
        enviarPulso(agenteId, { touchpoint: false, botonSalida: false, estado: 'sin_sesion', estadoTP: 'Cerró Touchpoint' }, true);
        await borrarTab(agenteId);
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name.startsWith(ALARMA)) {
        const id = alarm.name.replace(ALARMA, "");
        const configSnap = await getDoc("config", "global");
        if (configSnap.exists && configSnap.data().autoExpulsion === false) return;
        expulsarAgente(id);
    }
});

async function expulsarAgente(agenteId) {
    procesarEnOrden(agenteId, null, 'EXPULSION_SISTEMA');
    const tabId = await obtenerTab(agenteId);
    if (tabId) chrome.tabs.sendMessage(tabId, { action: 'FORZAR_LOGOUT' }).catch(() => botarFallback());
    else botarFallback();
}

function botarFallback() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { action: 'FORZAR_LOGOUT' }).catch(() => {}));
    });
}

// =====================================================================
// 5. PULSO: "la extensión está viva y ve Touchpoint"
// Se guarda en extension_estado/{agenteId}. La web lo lee para mostrar
// "Extensión conectada / desconectada".
// =====================================================================
async function enviarPulso(agenteId, diag, forzar = false) {
    if (!agenteId) return;
    const firma = JSON.stringify([!!diag.touchpoint, !!diag.botonSalida, diag.estado || null, diag.estadoTP || '']);
    const { ultimoPulso = {} } = await chrome.storage.session.get('ultimoPulso');
    const prev = ultimoPulso[agenteId];
    if (!forzar && prev && prev.firma === firma && Date.now() - prev.ts < PULSO_MIN_MS) return;
    ultimoPulso[agenteId] = { firma, ts: Date.now() };
    await chrome.storage.session.set({ ultimoPulso });

    await setDoc('extension_estado', agenteId, {
        ultimoPulso: Date.now(),
        version: VERSION,
        touchpoint: !!diag.touchpoint,       // ¿está dentro de Touchpoint con sesión iniciada?
        botonSalida: !!diag.botonSalida,     // ¿encuentra el botón para desconectarlo?
        estado: diag.estado || 'trabajando', // lo que la extensión entendió (bath/food/quality/trabajando/sin_sesion)
        estadoTP: diag.estadoTP || ''        // texto tal cual de Touchpoint (ej. "Disponible")
    });
}

// =====================================================================
// 6. ESCRITURA DE SESIÓN Y BITÁCORA
// =====================================================================
async function actualizarBD(agenteId, nuevoEstado, razon) {
    try {
        const hoy = fechaHoy();
        const snap = await getDoc("sesiones_activas", agenteId);
        // Si no se pudo leer (sin internet, error), NO escribimos: antes esto borraba los tiempos del día
        if (snap.error) { console.warn("No se pudo leer la sesión; se omite este cambio."); return; }

        const vacia = { fecha: hoy, tiemposAcumulados: { bath: 0, food: 0, quality: 0 }, primeraConexion: null };
        let data = snap.exists ? snap.data() : vacia;
        if (!esDeHoy(data.fecha)) data = vacia;
        data.fecha = hoy;
        if (!data.tiemposAcumulados) data.tiemposAcumulados = { bath: 0, food: 0, quality: 0 };

        const ahora = Date.now();
        const anterior = data.estadoActivo;
        chrome.alarms.clear(ALARMA + agenteId);

        let opNombre = "Desconocido";
        const op = await getDoc("operadores", agenteId);
        if (op.exists) opNombre = op.data().nombre || opNombre;

        // LOG 1: Primera conexión del día
        if (!data.primeraConexion && razon !== 'LOGOUT_MANUAL' && razon !== 'EXPULSION_SISTEMA') {
            data.primeraConexion = ahora;
            await addDoc("registros_tiempos", {
                asesor_id: agenteId, asesor_nombre: opNombre,
                tipo_evento: "LOGIN", estado: "Conexión al Sistema",
                duracion_segundos: 0, inicio: ahora, fin: ahora,
                fecha: { _isTimestamp: true }
            });
        }

        let seg = 0;
        const inicioCalc = data.tiempoInicioEstado || ahora;
        if (anterior) {
            seg = Math.floor((ahora - inicioCalc) / 1000);
            data.tiemposAcumulados[anterior] = (data.tiemposAcumulados[anterior] || 0) + seg;
        } else if (razon === 'LOGOUT_MANUAL' || razon === 'EXPULSION_SISTEMA') {
            seg = Math.floor((ahora - inicioCalc) / 1000);
        }

        data.estadoActivo = nuevoEstado || null;
        data.tiempoInicioEstado = nuevoEstado ? ahora : (razon === 'LOGOUT_MANUAL' || razon === 'EXPULSION_SISTEMA' ? null : ahora);
        if (razon === 'LOGOUT_MANUAL' || razon === 'EXPULSION_SISTEMA') data.ultimaDesconexion = ahora;
        await setDoc("sesiones_activas", agenteId, data);

        // LOG 2: evento detallado (pausas > 5 s, salidas y expulsiones)
        let tipoEvt = anterior ? 'FIN_BREAK' : 'FIN_TRABAJO';
        if (razon === 'LOGOUT_MANUAL') tipoEvt = 'LOGOUT_MANUAL';
        if (razon === 'EXPULSION_SISTEMA') tipoEvt = 'EXPULSION_SISTEMA';

        if ((anterior && seg > 5) || razon === 'LOGOUT_MANUAL' || razon === 'EXPULSION_SISTEMA') {
            await addDoc("registros_tiempos", {
                asesor_id: agenteId, asesor_nombre: opNombre,
                tipo_evento: tipoEvt,
                estado: anterior || 'Trabajando (Disponible)',
                duracion_segundos: seg, inicio: inicioCalc, fin: ahora,
                fecha: { _isTimestamp: true }
            });
        }

        // Nueva alarma de expulsión
        if (nuevoEstado) {
            const config = await getDoc("config", "global");
            const limiteKey = MAPEO_LIMITES[nuevoEstado];
            let limiteMin = 999;
            if (op.exists && op.data().limites && op.data().limites[limiteKey]) limiteMin = op.data().limites[limiteKey];
            else if (config.exists && config.data().limites && config.data().limites[limiteKey]) limiteMin = config.data().limites[limiteKey];

            const restanMin = ((limiteMin * 60) - (data.tiemposAcumulados[nuevoEstado] || 0)) / 60;
            if (restanMin <= 0) expulsarAgente(agenteId);
            else chrome.alarms.create(ALARMA + agenteId, { delayInMinutes: restanMin });
        }
    } catch (e) {
        console.error("Error Firebase:", e);
    }
}
