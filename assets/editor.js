// =====================================================================
// Editor del supervisor: registros de pausas y sesión del día.
// Lo usan super/dash.html y super/logs.html.
// Al editar/borrar/agregar una pausa de HOY también se ajustan los
// tiempos acumulados del asesor (lo que se ve en el monitor).
// =====================================================================
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, increment } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const TIPOS = {
    bath:    { label: 'Baño',    key: 'bath' },
    food:    { label: 'Comida',  key: 'food' },
    quality: { label: 'Calidad', key: 'quality' }
};
const ALIAS = { 'Baño': 'bath', 'Comida': 'food', 'Calidad': 'quality', bath: 'bath', food: 'food', quality: 'quality' };

const pad = (n) => String(n).padStart(2, '0');
const mmss = (s) => `${pad(Math.floor((s || 0) / 60))}:${pad((s || 0) % 60)}`;
const parseMMSS = (t) => { const p = String(t || '').trim().split(':'); if (p.length === 1) return (parseInt(p[0]) || 0) * 60; return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0); };
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hoyA = (hm) => { const [h, m] = hm.split(':'); const d = new Date(); d.setHours(+h, +m, 0, 0); return d.getTime(); };
const isoLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const esMismoDia = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaHoyNormal = () => new Date().toLocaleDateString();
const esFechaDeHoy = (f) => { const d = new Date(); const iso = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().split('T')[0]; return f === d.toLocaleDateString() || f === iso; };
const msDe = (f) => f?.toDate ? f.toDate().getTime() : (f instanceof Date ? f.getTime() : f);

// ¿Este registro cuenta para los totales del día? (pausa real, no marcador)
const aporte = (r) => (ALIAS[r.estado] && !r.pausa_sigue) ? { key: ALIAS[r.estado], seg: r.duracion_segundos || 0, ms: r.fin || msDe(r.fecha) } : null;

export function instalarEditor({ db, toast, operadores, alGuardar }) {
    // ---------- Modal ----------
    const wrap = document.createElement('div');
    wrap.innerHTML = `
    <div id="ed-overlay" class="backdrop hidden opacity-0 flex items-center justify-center p-4 overflow-y-auto" style="z-index:80">
        <div id="ed-modal" class="modal w-full max-w-md p-6 scale-95 m-auto">
            <div class="flex items-start justify-between gap-3 mb-4">
                <div class="flex items-center gap-3">
                    <div class="icon-tile soft-brand c-brand"><i id="ed-icon" class="ph-bold ph-pencil-simple"></i></div>
                    <div><h3 class="text-lg font-bold text-1 leading-tight" id="ed-title">Editar</h3><p class="text-[13px] muted" id="ed-sub"></p></div>
                </div>
                <button class="btn btn-ghost btn-icon btn-sm" data-ed="cerrar"><i class="ph-bold ph-x"></i></button>
            </div>
            <div id="ed-body" class="flex flex-col gap-4"></div>
            <p id="ed-nota" class="hint"></p>
            <div class="flex items-center gap-2.5 mt-5">
                <button id="ed-borrar" class="btn btn-danger hidden"><i class="ph-bold ph-trash"></i> Borrar</button>
                <button id="ed-extra" class="btn btn-secondary hidden"></button>
                <div class="flex-1"></div>
                <button class="btn btn-secondary" data-ed="cerrar">Cancelar</button>
                <button id="ed-guardar" class="btn btn-primary"><i class="ph-bold ph-check"></i> Guardar</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(wrap.firstElementChild);
    const $ = (id) => document.getElementById(id);
    const overlay = $('ed-overlay'), modal = $('ed-modal');

    function abrir() { overlay.classList.remove('hidden'); setTimeout(() => { overlay.classList.remove('opacity-0'); modal.classList.remove('scale-95'); }, 10); }
    function cerrar() { overlay.classList.add('opacity-0'); modal.classList.add('scale-95'); setTimeout(() => overlay.classList.add('hidden'), 180); }
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-ed="cerrar"]')) cerrar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) cerrar(); });

    // MM:SS automático mientras escribe
    function mascaraMMSS(el) {
        el.addEventListener('input', () => {
            let v = el.value.replace(/\D/g, '').slice(0, 5);
            el.value = v.length >= 3 ? v.slice(0, v.length - 2) + ':' + v.slice(-2) : v;
        });
    }
    function botones({ borrar = null, extra = null, guardar }) {
        const b = $('ed-borrar'), x = $('ed-extra'), g = $('ed-guardar');
        b.classList.toggle('hidden', !borrar); x.classList.toggle('hidden', !extra);
        b.onclick = borrar; g.onclick = guardar;
        if (extra) { x.innerHTML = extra.html; x.onclick = extra.fn; }
    }
    async function ocupado(btn, fn) {
        const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
        try { await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
    }

    // Ajusta los acumulados de hoy si la sesión existe y es de hoy
    async function ajustarSesion(asesorId, key, delta) {
        if (!asesorId || !key || !delta) return;
        const ref = doc(db, 'sesiones_activas', asesorId);
        const snap = await getDoc(ref);
        if (!snap.exists() || !esFechaDeHoy(snap.data().fecha)) return;
        await updateDoc(ref, { [`tiemposAcumulados.${key}`]: increment(delta) });
    }
    async function aplicarDiferencia(asesorId, antes, despues) {
        const hoy = Date.now();
        const a = antes && esMismoDia(antes.ms, hoy) ? antes : null;
        const d = despues && esMismoDia(despues.ms, hoy) ? despues : null;
        if (a && d && a.key === d.key) return ajustarSesion(asesorId, a.key, d.seg - a.seg);
        if (a) await ajustarSesion(asesorId, a.key, -a.seg);
        if (d) await ajustarSesion(asesorId, d.key, d.seg);
    }

    const nombreDe = (id, fallback) => { const o = operadores()[id]; return o ? (o.nombreCorto || o.nombre) : (fallback || 'ID ' + id); };
    const selectTipos = (sel, extraOpt) => Object.values(TIPOS).map(t => `<option value="${t.key}" ${sel === t.key ? 'selected' : ''}>${t.label}</option>`).join('') + (extraOpt || '');

    // =================================================================
    // 1) Registro de la bitácora (editar / borrar / nuevo)
    // =================================================================
    function editarRegistro(reg) {
        const nuevo = !reg;
        const r = reg || { estado: 'bath', duracion_segundos: 0, fin: Date.now() };
        const finMs = r.fin || msDe(r.fecha) || Date.now();
        const tipo = ALIAS[r.estado];
        const esLogin = !nuevo && r.tipo_evento === 'LOGIN';
        const opsAsesores = Object.values(operadores()).sort((a, b) => (a.nombreCorto || a.nombre || '').localeCompare(b.nombreCorto || b.nombre || ''))
            .map(o => `<option value="${esc(o.id)}">${esc(o.nombreCorto || o.nombre)} · ${esc(o.id)}</option>`).join('');

        $('ed-icon').className = nuevo ? 'ph-bold ph-plus' : (esLogin ? 'ph-bold ph-sign-in' : 'ph-bold ph-pencil-simple');
        $('ed-title').textContent = nuevo ? 'Agregar pausa' : (esLogin ? 'Primera conexión' : 'Editar registro');
        $('ed-sub').textContent = nuevo ? 'Se suma a la bitácora y a los tiempos del día' : `${nombreDe(r.asesor_id, r.asesor_nombre)} · ${esLogin ? 'primera conexión del día' : (r.tipo_evento ? r.tipo_evento.replace('_', ' ').toLowerCase() : 'registro web')}`;
        $('ed-body').innerHTML = esLogin
            ? `<div><label class="label">Se conectó a las</label><input id="ed-fin" type="datetime-local" class="input" value="${isoLocal(finMs)}"></div>`
            : `
            ${nuevo ? `<div><label class="label">Asesor</label><select id="ed-asesor" class="input">${opsAsesores}</select></div>` : ''}
            <div class="grid grid-cols-2 gap-3">
                <div><label class="label">Tipo</label>
                    <select id="ed-tipo" class="input" ${!tipo && !nuevo ? 'disabled' : ''}>${tipo || nuevo ? selectTipos(tipo || 'bath') : `<option>${esc(r.estado || '—')}</option>`}</select></div>
                <div><label class="label">Duración (MM:SS)</label><input id="ed-dur" class="input tnum text-center font-semibold" value="${mmss(r.duracion_segundos)}"></div>
            </div>
            <div><label class="label">Terminó</label><input id="ed-fin" type="datetime-local" class="input" value="${isoLocal(finMs)}"></div>
            ${r.pausa_sigue ? '<p class="chip chip-warn !h-auto !py-2 !rounded-[10px] !whitespace-normal">Este es el marcador de una desconexión; no suma a los totales.</p>' : ''}`;
        if (!esLogin) mascaraMMSS($('ed-dur'));
        $('ed-nota').textContent = esLogin ? 'Es la primera conexión del día: solo tiene hora, no duración ni tipo.' : 'Si la pausa es de hoy, el tiempo del asesor en el monitor se ajusta solo.';

        botones({
            borrar: nuevo ? null : () => ocupado($('ed-borrar'), async () => {
                if (!confirm('¿Borrar este registro? No se puede deshacer.')) return;
                try {
                    await deleteDoc(doc(db, 'registros_tiempos', r.id));
                    await aplicarDiferencia(r.asesor_id, aporte(r), null);
                    toast('Registro borrado.'); cerrar(); alGuardar && alGuardar();
                } catch (e) { console.error(e); toast('No se pudo borrar (¿iniciaste sesión de supervisor?).', 'error'); }
            }),
            guardar: () => ocupado($('ed-guardar'), async () => {
                const finNuevo = new Date($('ed-fin').value).getTime();
                if (!finNuevo) { toast('Revisa la fecha y hora.', 'error'); return; }
                try {
                    if (esLogin) {
                        const cambios = { inicio: finNuevo, fin: finNuevo, duracion_segundos: 0, fecha: new Date(finNuevo), editado_por_supervisor: true, editado_en: Date.now() };
                        await updateDoc(doc(db, 'registros_tiempos', r.id), cambios);
                        toast('Hora de conexión actualizada.');
                    } else if (nuevo) {
                        const seg = parseMMSS($('ed-dur').value);
                        const tipoNuevo = $('ed-tipo').value;
                        const id = $('ed-asesor').value;
                        const op = operadores()[id] || {};
                        const data = { asesor_id: id, asesor_nombre: op.nombre || '', estado: tipoNuevo, duracion_segundos: seg,
                            tipo_evento: 'FIN_BREAK', inicio: finNuevo - seg * 1000, fin: finNuevo, fecha: new Date(finNuevo),
                            agregado_por_supervisor: true };
                        await addDoc(collection(db, 'registros_tiempos'), data);
                        await aplicarDiferencia(id, null, aporte(data));
                        toast('Pausa agregada.');
                    } else {
                        const seg = parseMMSS($('ed-dur').value);
                        const tipoNuevo = $('ed-tipo').disabled ? r.estado : $('ed-tipo').value;
                        const cambios = { estado: tipoNuevo, duracion_segundos: seg, fin: finNuevo, inicio: finNuevo - seg * 1000,
                            fecha: new Date(finNuevo), editado_por_supervisor: true, editado_en: Date.now() };
                        await updateDoc(doc(db, 'registros_tiempos', r.id), cambios);
                        await aplicarDiferencia(r.asesor_id, aporte(r), aporte({ ...r, ...cambios }));
                        toast('Registro actualizado.');
                    }
                    cerrar(); alGuardar && alGuardar();
                } catch (e) { console.error(e); toast('No se pudo guardar (¿iniciaste sesión de supervisor?).', 'error'); }
            })
        });
        abrir();
        setTimeout(() => (nuevo ? $('ed-asesor') : (esLogin ? $('ed-fin') : $('ed-dur'))).focus(), 60);
    }

    // =================================================================
    // 2) Sesión del día de un asesor
    // =================================================================
    function editarSesion(ag, sesActual) {
        const ses = sesActual || { tiemposAcumulados: { bath: 0, food: 0, quality: 0 }, estadoActivo: null };
        const t = ses.tiemposAcumulados || {};
        const activo = ALIAS[ses.estadoActivo] || '';
        $('ed-icon').className = 'ph-bold ph-user-gear';
        $('ed-title').textContent = 'Editar día de ' + (ag.nombreCorto || ag.nombre);
        $('ed-sub').textContent = 'ID ' + ag.id + ' · cambios directos sobre hoy';
        $('ed-body').innerHTML = `
            <div class="grid grid-cols-2 gap-3">
                <div><label class="label">Hora de entrada</label><input id="es-entrada" type="time" class="input tnum" value="${ses.primeraConexion ? hhmm(ses.primeraConexion) : ''}"></div>
                <div><label class="label">Estado actual</label>
                    <select id="es-estado" class="input"><option value="">Trabajando</option>${selectTipos(activo)}</select></div>
            </div>
            <div id="es-inicio-box" class="${activo ? '' : 'hidden'}"><label class="label">La pausa actual empezó a las</label>
                <input id="es-inicio" type="time" class="input tnum" value="${ses.tiempoInicioEstado ? hhmm(ses.tiempoInicioEstado) : hhmm(Date.now())}"></div>
            <div>
                <p class="label">Tiempo usado hoy (sin contar la pausa en curso)</p>
                <div class="grid grid-cols-3 gap-3">
                    <div><label class="text-[12px] subtle flex items-center gap-1.5 mb-1"><span class="dot bg-bath"></span>Baño</label><input id="es-bath" class="input tnum text-center font-semibold" value="${mmss(t.bath)}"></div>
                    <div><label class="text-[12px] subtle flex items-center gap-1.5 mb-1"><span class="dot bg-food"></span>Comida</label><input id="es-food" class="input tnum text-center font-semibold" value="${mmss(t.food)}"></div>
                    <div><label class="text-[12px] subtle flex items-center gap-1.5 mb-1"><span class="dot bg-quality"></span>Calidad</label><input id="es-quality" class="input tnum text-center font-semibold" value="${mmss(t.quality)}"></div>
                </div>
            </div>
            ${ses.desconectadoEn ? `<label class="flex items-start gap-2.5 cursor-pointer soft-danger rounded-xl p-3" style="border:1px solid var(--danger-border)">
                <input type="checkbox" id="es-fuera" class="checkbox mt-0.5">
                <span class="text-[13px]"><span class="font-semibold c-danger block">Fuera de Touchpoint desde las ${hhmm(ses.desconectadoEn)}</span><span class="muted">Marca para quitar esa marca (el cronómetro de la pausa sigue igual).</span></span></label>` : ''}`;
        ['es-bath', 'es-food', 'es-quality'].forEach(id => mascaraMMSS($(id)));
        $('es-estado').addEventListener('change', () => $('es-inicio-box').classList.toggle('hidden', !$('es-estado').value));
        $('ed-nota').textContent = 'Para cerrar la pausa y que quede en la bitácora, usa "Terminar pausa".';

        const ref = doc(db, 'sesiones_activas', ag.id);
        botones({
            extra: activo ? { html: '<i class="ph-bold ph-stop-circle"></i> Terminar pausa', fn: () => ocupado($('ed-extra'), async () => {
                const ahora = Date.now();
                const seg = Math.max(0, Math.floor((ahora - (ses.tiempoInicioEstado || ahora)) / 1000));
                const acumulados = { ...{ bath: 0, food: 0, quality: 0 }, ...t };
                acumulados[activo] = (acumulados[activo] || 0) + seg;
                try {
                    await setDoc(ref, { estadoActivo: null, tiempoInicioEstado: ahora, desconectadoEn: null, motivoDesconexion: null,
                        tiemposAcumulados: acumulados, fecha: esFechaDeHoy(ses.fecha) ? ses.fecha : fechaHoyNormal() }, { merge: true });
                    await addDoc(collection(db, 'registros_tiempos'), { asesor_id: ag.id, asesor_nombre: ag.nombre || '', tipo_evento: 'FIN_BREAK',
                        estado: activo, duracion_segundos: seg, inicio: ses.tiempoInicioEstado || ahora, fin: ahora, fecha: new Date(ahora),
                        cerrado_por_supervisor: true,
                        ...(ses.desconectadoEn ? { tras_desconexion: ses.motivoDesconexion || 'manual', seg_fuera_touchpoint: Math.floor((ahora - ses.desconectadoEn) / 1000) } : {}) });
                    toast(`Pausa terminada (${mmss(seg)}).`); cerrar(); alGuardar && alGuardar();
                } catch (e) { console.error(e); toast('No se pudo terminar la pausa.', 'error'); }
            }) } : null,
            guardar: () => ocupado($('ed-guardar'), async () => {
                const estado = $('es-estado').value || null;
                const datos = {
                    fecha: esFechaDeHoy(ses.fecha) ? ses.fecha : fechaHoyNormal(),
                    primeraConexion: $('es-entrada').value ? hoyA($('es-entrada').value) : null,
                    tiemposAcumulados: { bath: parseMMSS($('es-bath').value), food: parseMMSS($('es-food').value), quality: parseMMSS($('es-quality').value) },
                    estadoActivo: estado,
                    tiempoInicioEstado: estado ? hoyA($('es-inicio').value || hhmm(Date.now())) : (ses.tiempoInicioEstado || Date.now()),
                    editado_por_supervisor: Date.now()
                };
                if (!estado || ($('es-fuera') && $('es-fuera').checked)) { datos.desconectadoEn = null; datos.motivoDesconexion = null; }
                try { await setDoc(ref, datos, { merge: true }); toast('Día actualizado.'); cerrar(); alGuardar && alGuardar(); }
                catch (e) { console.error(e); toast('No se pudo guardar.', 'error'); }
            })
        });
        abrir();
    }

    return { editarRegistro, editarSesion, nuevoRegistro: () => editarRegistro(null) };
}
