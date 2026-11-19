/**
 * =====================================================================
 *  CASOS automáticos  (hoja CASOS del documento OMT ↔ omt.godsplan.site/casos)
 *
 *  Qué hace:
 *   1. Cada 10 minutos lee "Fallas e inconsistencias_NOCTURNO" y mete los
 *      casos NUEVOS a la hoja CASOS: con folio OMT-xxxxx, tipo de caso,
 *      status "Pendiente" y asesor asignado (al que tenga menos casos
 *      abiertos, recibe casos = SI y no esté de descanso hoy en ROL).
 *      Lo que escribió el nocturno (PRUEBAS) queda como nota en USUARIO.
 *   2. Copia la hoja CASOS a Firebase para que cada asesor vea SUS casos
 *      en la página. Si editas la hoja, la página cambia al momento.
 *   3. Lo que los asesores guardan en la página se escribe en la hoja
 *      (revisa cada minuto).
 *
 *  Necesita el archivo "Pagina" (usa su contraseña de Firebase).
 *
 *  Cómo se instala (una sola vez):
 *    1. Extensiones → Apps Script → + → Secuencia de comandos → nómbralo
 *       Casos, pega este código y guarda.
 *    2. En el onOpen() del otro archivo (donde ya pusiste menuPagina_();)
 *       agrega abajo la línea   menuCasos_();   y recarga la hoja.
 *    3. Menú 📋 Casos → "1. Activar casos automáticos". Google te pedirá
 *       permisos (para leer el archivo del nocturno): acéptalos.
 * =====================================================================
 */

const CASOS = {
  nocturnoId: '1E20u7hAZJv8XrnqoVad6KXlDHj1N9IdGJohPXeZUUNI', // Fallas e inconsistencias_NOCTURNO
  nocturnoHoja: 'Hoja 1',
  hoja: 'CASOS',
  historial: ['H_CASOS', 'CASOS_ANTIGUOS'],  // aquí también se buscan folios y casos repetidos
  asign: 'ASIGN',
  rol: 'ROL',
  registro: '_CASOS_IMPORTADOS',             // hoja oculta: lo que ya se importó (para no repetir)
  coleccion: 'casos',
  prefijoFolio: 'OMT-',
  digitosFolio: 5,
  statusNuevo: 'Pendiente',
  horas: [6, 23],                            // fuera de este horario no revisa la página (ahorra cuota)
  noRecibeHoy: /DESCANSO|VACACION|PERMISO|INCAPACIDAD|FALTA|BAJA/,
  zona: 'America/Mexico_City',
  // Respaldo por si la hoja no tiene listas desplegables
  tipos: ['NOCTURNO', 'SMARTWATCH', 'COBERTURA', 'NAVEGACION', 'LLAMADAS', 'RED', 'VOZ', 'SMS'],
  status: ['Pendiente', 'En Proceso', 'Cerrado'],
  acciones: ['No contesta / Buzón', 'No contesta', 'Llamar más tarde', 'Escalado', 'Navegación Exitosa', 'Activación Exitosa', 'Sin número de contacto']
};

// ---------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------
function menuCasos_() {
  SpreadsheetApp.getUi().createMenu('📋 Casos')
    .addItem('1. Activar casos automáticos', 'activarCasos')
    .addSeparator()
    .addItem('Traer casos del nocturno ahora', 'importarNocturnoAhora')
    .addItem('Sincronizar con la página ahora', 'sincronizarCasosAhora')
    .addItem('Ver estado', 'verEstadoCasos')
    .addItem('Cambiar desde qué fecha se importa', 'cambiarFechaDesde')
    .addItem('Desactivar casos automáticos', 'desactivarCasos')
    .addToUi();
}

function activarCasos() {
  desactivarCasos(true);
  ScriptApp.newTrigger('casosCadaMinuto').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('casosCada10').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('alEditarCasos').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  const res = casosCada10();
  SpreadsheetApp.getUi().alert('✅ Casos automáticos activados.\n\n' +
    '• Cada 10 min se traen los casos nuevos del nocturno.\n' +
    '• Lo que edites en CASOS se ve en la página al momento.\n' +
    '• Lo que guarden en la página llega a la hoja en ~1 minuto.\n\nPrimera vuelta:\n' + res);
}

function desactivarCasos(silencioso) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['casosCadaMinuto', 'casosCada10', 'alEditarCasos'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  if (silencioso !== true) SpreadsheetApp.getUi().alert('Casos automáticos desactivados. La hoja sigue igual; solo deja de sincronizar.');
}

function importarNocturnoAhora() { SpreadsheetApp.getUi().alert(conLock_(function () { return importarNocturno_() + '\n' + sincronizarCasos_(); })); }
function sincronizarCasosAhora() { SpreadsheetApp.getUi().alert(conLock_(function () { return aplicarPendientesWeb_() + '\n' + sincronizarCasos_(); })); }

function verEstadoCasos() {
  const p = PropertiesService.getScriptProperties();
  const act = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  SpreadsheetApp.getUi().alert(
    'Automático: ' + (act.indexOf('casosCada10') >= 0 ? '✅ activo' : '⛔ apagado') + '\n' +
    'Importa casos del nocturno con fecha desde: ' + (p.getProperty('CASOS_DESDE') || '(se calcula en la primera vuelta)') + '\n' +
    'Última importación: ' + (p.getProperty('CASOS_ULT_IMPORT') || 'nunca') + '\n' +
    'Última sincronización: ' + (p.getProperty('CASOS_ULT_SYNC') || 'nunca') + '\n' +
    'Último cambio desde la página: ' + (p.getProperty('CASOS_ULT_WEB') || 'ninguno') + '\n' +
    'Último error: ' + (p.getProperty('CASOS_ERROR') || 'ninguno'));
}

function cambiarFechaDesde() {
  const ui = SpreadsheetApp.getUi(), p = PropertiesService.getScriptProperties();
  const r = ui.prompt('Importar casos del nocturno desde…',
    'Fecha (dd/mm/aaaa). Solo se traen casos del nocturno con esa fecha o posterior.\nAhora: ' + (p.getProperty('CASOS_DESDE') || 'sin definir'),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const f = aFecha_(r.getResponseText().trim());
  if (!f) { ui.alert('No entendí la fecha. Usa dd/mm/aaaa.'); return; }
  p.setProperty('CASOS_DESDE', ymd_(f));
  ui.alert('Listo: desde ' + fmt_(f) + '.');
}

// ---------------------------------------------------------------------
// Activadores
// ---------------------------------------------------------------------
function casosCadaMinuto() {
  const h = Number(Utilities.formatDate(new Date(), CASOS.zona, 'H'));
  if (h < CASOS.horas[0] || h >= CASOS.horas[1]) return;
  conLock_(aplicarPendientesWeb_, 5000);
}

function casosCada10() {
  return conLock_(function () {
    return [aplicarPendientesWeb_(), importarNocturno_(), sincronizarCasos_()].join('\n');
  });
}

// Edición a mano en la hoja → se manda a la página al momento.
function alEditarCasos(e) {
  try {
    if (!e || !e.range || e.range.getSheet().getName() !== CASOS.hoja) return;
    const r1 = Math.max(2, e.range.getRow()), r2 = e.range.getLastRow();
    if (r2 < 2) return;
    conLock_(function () { return sincronizarCasos_(r1, r2); }, 10000);
  } catch (err) { errorCasos_(err); }
}

function conLock_(fn, espera) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(espera || 30000)) return 'Ya había otra sincronización en curso.';
  try { return fn(); }
  catch (e) { errorCasos_(e); return '❌ Error: ' + e.message; }
  finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function nc_(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(); }
function dig_(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function linea_(s) { const d = dig_(s); return d.length > 10 ? d.slice(-10) : d; }
function fmt_(d) { return d ? Utilities.formatDate(d, CASOS.zona, 'dd/MM/yyyy') : ''; }
function ymd_(d) { return d ? Utilities.formatDate(d, CASOS.zona, 'yyyy-MM-dd') : ''; }
function hoyYmd_() { return ymd_(new Date()); }
// Nombre sin importar el orden: "SANCHEZ LOPEZ SEBASTIAN" = "SEBASTIAN SANCHEZ LOPEZ"
function claveNombre_(s) { return nc_(s).split(' ').filter(String).sort().join(' '); }

function aFecha_(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5) + 12 * 36e5);
  const m = String(v || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let a = +m[3]; if (a < 100) a += 2000;
    const d = new Date(a, +m[2] - 1, +m[1], 12);
    return d.getMonth() === +m[2] - 1 ? d : null;
  }
  const iso = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], 12);
  return null;
}

// FALLA del nocturno → TIPO DE CASO válido de la hoja
function tipoDeFalla_(falla, tipos) {
  const f = nc_(falla);
  const reglas = [
    ['SMARTWATCH', /WATCH|RELOJ/],
    ['COBERTURA', /COBERTURA|UBICACION|SENAL/],
    ['NAVEGACION', /NAVEG|INTERNET|DATOS/],
    ['LLAMADAS', /LLAM|LLAMD/],
    ['VOZ', /\bVOZ\b/],
    ['SMS', /\bSMS\b|MENSAJ/],
    ['RED', /\bRED\b/]
  ];
  // Si menciona varias cosas, gana la que aparece primero en el texto
  let mejor = null, pos = 1e9;
  reglas.forEach(function (r) {
    const m = f.match(r[1]);
    if (m && m.index < pos && tipos.indexOf(r[0]) >= 0) { pos = m.index; mejor = r[0]; }
  });
  if (mejor) return mejor;
  return tipos.indexOf('NOCTURNO') >= 0 ? 'NOCTURNO' : tipos[0];
}

function errorCasos_(err) {
  PropertiesService.getScriptProperties().setProperty('CASOS_ERROR', new Date().toLocaleString('es-MX', { timeZone: CASOS.zona }) + ' · ' + (err && err.message ? err.message : err));
  console.error(err);
}

function ahora_() { return new Date().toLocaleString('es-MX', { timeZone: CASOS.zona }); }

// ---------------------------------------------------------------------
// Lectura de la hoja CASOS
// ---------------------------------------------------------------------
function columnas_(cab) {
  const h = cab.map(nc_), c = {};
  const busca = function (re, desde) { for (let i = desde || 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; };
  c.fecha = busca(/^FECHA$/);
  c.usuario = busca(/^USUARIO|NOMBRE/);
  c.tipo = busca(/^TIPO/);
  c.afectada = busca(/AFECTADA/);
  c.contacto = busca(/CONTACTO/);
  c.asesor = busca(/^ASESOR/);
  c.status = busca(/^STATUS|^ESTATUS/);
  c.accion = busca(/^ULTIMA ACCION/);
  c.fechaUltima = busca(/^FECHA ULTIMA|^ULTIMA ACCION/, c.accion + 1);
  c.intentos = busca(/^INTENTOS/);
  c.notas = busca(/^NOTAS/);
  c.observacion = busca(/^OBSERVACION/);
  c.folio = busca(/^FOLIO/);
  return c;
}

function leerHojaCasos_(nombre) {
  const hoja = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!hoja) return null;
  const ncol = hoja.getLastColumn(), nfil = hoja.getLastRow();
  if (nfil < 1) return { hoja: hoja, c: {}, filas: [] };
  const v = hoja.getRange(1, 1, nfil, ncol).getValues();
  const c = columnas_(v[0]);
  const filas = [];
  for (let i = 1; i < v.length; i++) {
    const f = v[i];
    const tiene = [c.usuario, c.afectada, c.folio].some(function (k) { return k >= 0 && String(f[k]).trim() !== ''; });
    if (tiene) filas.push({ fila: i + 1, v: f });
  }
  return { hoja: hoja, c: c, filas: filas, ncol: ncol };
}

function leerAsign_() {
  const h = SpreadsheetApp.getActive().getSheetByName(CASOS.asign);
  if (!h || h.getLastRow() < 2) return [];
  const v = h.getRange(1, 1, h.getLastRow(), h.getLastColumn()).getValues();
  const cab = v[0].map(nc_);
  const ix = function (re) { for (let i = 0; i < cab.length; i++) if (re.test(cab[i])) return i; return -1; };
  const iN = ix(/^ASESOR/), iId = ix(/^ID$/), iR = ix(/RECIBE/), iNom = ix(/NOMINA/);
  return v.slice(1).filter(function (f) { return String(f[iId] || '').trim(); }).map(function (f) {
    return {
      nombre: String(f[iN] || '').trim(),
      id: String(f[iId]).trim().toUpperCase(),
      nomina: iNom >= 0 ? String(f[iNom] || '').trim() : '',
      recibe: iR < 0 || nc_(f[iR]) !== 'NO'
    };
  });
}

// Quién está de descanso / vacaciones / permiso hoy (según ROL)
function fueraHoy_(asesores) {
  const out = {};
  const h = SpreadsheetApp.getActive().getSheetByName(CASOS.rol);
  if (!h || h.getLastRow() < 3) return out;
  const v = h.getRange(1, 1, h.getLastRow(), h.getLastColumn()).getDisplayValues();
  const hoy = hoyYmd_();
  let col = -1;
  for (let r = 0; r < Math.min(3, v.length) && col < 0; r++) col = v[r].indexOf(hoy);
  if (col < 0) return out;
  v.forEach(function (f) {
    const t = nc_(f[col]);
    if (!t || !CASOS.noRecibeHoy.test(t)) return;
    asesores.forEach(function (a) {
      if ((a.nomina && String(f[0]).trim() === a.nomina) || claveNombre_(f[1]) === claveNombre_(a.nombre)) out[a.id] = t;
    });
  });
  return out;
}

function listaDe_(hoja, fila, col, respaldo) {
  try {
    if (col < 0) return respaldo;
    const dv = hoja.getRange(fila, col + 1).getDataValidation();
    if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      const l = dv.getCriteriaValues()[0];
      if (l && l.length) return l.map(String);
    }
  } catch (e) {}
  return respaldo;
}

function siguienteFolio_() {
  let max = 0;
  [CASOS.hoja].concat(CASOS.historial).forEach(function (n) {
    const d = leerHojaCasos_(n);
    if (!d || d.c.folio < 0) return;
    d.filas.forEach(function (x) {
      const m = String(x.v[d.c.folio]).match(/(\d+)\s*$/);
      if (m && /OMT/i.test(x.v[d.c.folio])) max = Math.max(max, +m[1]);
    });
  });
  return max;
}
function folio_(n) { return CASOS.prefijoFolio + ('0000000000' + n).slice(-CASOS.digitosFolio); }

// ---------------------------------------------------------------------
// 1. Importar del nocturno
// ---------------------------------------------------------------------
function registroImport_() {
  const ss = SpreadsheetApp.getActive();
  let h = ss.getSheetByName(CASOS.registro);
  if (!h) {
    h = ss.insertSheet(CASOS.registro);
    h.getRange(1, 1, 1, 4).setValues([['CLAVE (línea|fecha)', 'FOLIO', 'IMPORTADO', 'ASESOR']]);
    h.hideSheet();
  }
  return h;
}

function importarNocturno_() {
  const props = PropertiesService.getScriptProperties();
  const casos = leerHojaCasos_(CASOS.hoja);
  if (!casos) return 'No encontré la pestaña ' + CASOS.hoja + '.';
  const c = casos.c;

  // Ya existentes (CASOS + historial + registro de importados).
  // Mismo número afectado con fecha a 7 días o menos (o sin fecha válida) = mismo caso.
  const existe = {}, porLinea = {};
  const yaEsta = function (lin, f) {
    if (existe[lin + '|' + ymd_(f)]) return true;
    return (porLinea[lin] || []).some(function (g) { return !g || !f || Math.abs(g - f) <= 7 * 864e5; });
  };
  let maxFecha = null;
  [CASOS.hoja].concat(CASOS.historial).forEach(function (n) {
    const d = n === CASOS.hoja ? casos : leerHojaCasos_(n);
    if (!d || d.c.afectada < 0) return;
    d.filas.forEach(function (x) {
      const f = aFecha_(x.v[d.c.fecha]), l = linea_(x.v[d.c.afectada]);
      if (l) { existe[l + '|' + ymd_(f)] = 1; (porLinea[l] = porLinea[l] || []).push(f); }
      if (f && (!maxFecha || f > maxFecha) && n !== 'CASOS_ANTIGUOS') maxFecha = f;
    });
  });
  const reg = registroImport_();
  if (reg.getLastRow() > 1) reg.getRange(2, 1, reg.getLastRow() - 1, 1).getValues().forEach(function (f) { if (f[0]) existe[f[0]] = 1; });

  // Desde qué fecha (la primera vez: la fecha más reciente que ya está en tus hojas)
  let desde = props.getProperty('CASOS_DESDE');
  if (!desde) { desde = maxFecha ? ymd_(maxFecha) : hoyYmd_(); props.setProperty('CASOS_DESDE', desde); }

  // Leer el archivo del nocturno
  const hn = SpreadsheetApp.openById(CASOS.nocturnoId).getSheetByName(CASOS.nocturnoHoja);
  if (!hn) throw new Error('No encontré la pestaña "' + CASOS.nocturnoHoja + '" en el archivo del nocturno.');
  const v = hn.getDataRange().getValues();
  let r0 = -1;
  for (let i = 0; i < Math.min(10, v.length); i++) if (v[i].some(function (x) { return /NOMBRE DEL TT/.test(nc_(x)); })) { r0 = i; break; }
  if (r0 < 0) throw new Error('No encontré los encabezados (NOMBRE DEL TT…) en el archivo del nocturno.');
  const cab = v[r0].map(nc_);
  const ix = function (re) { for (let i = 0; i < cab.length; i++) if (re.test(cab[i])) return i; return -1; };
  const n = { fecha: ix(/^FECHA/), nombre: ix(/NOMBRE DEL TT/), falla: ix(/^FALLA/), numero: ix(/^NUMERO/), contacto: ix(/^CONTACTO/),
              pruebas: ix(/^PRUEBAS/), asesor: ix(/^ASESOR/), sigue: ix(/CONTINUA/) };

  const tipos = listaDe_(casos.hoja, 2, c.tipo, CASOS.tipos);
  const nuevos = [];
  let saltados = 0;
  for (let i = r0 + 1; i < v.length; i++) {
    const f = v[i];
    const lin = linea_(f[n.numero]), fecha = aFecha_(f[n.fecha]);
    if (!lin && !String(f[n.nombre] || '').trim()) continue;   // fila vacía
    if (lin.length !== 10 || !fecha) { saltados++; continue; }
    if (ymd_(fecha) < desde) continue;
    const clave = lin + '|' + ymd_(fecha);
    if (yaEsta(lin, fecha)) continue;
    existe[clave] = 1; (porLinea[lin] = porLinea[lin] || []).push(fecha);
    nuevos.push({ clave: clave, fecha: fecha, nombre: String(f[n.nombre] || '').trim(), falla: String(f[n.falla] || '').trim(),
      linea: lin, contacto: linea_(f[n.contacto]) || lin, pruebas: n.pruebas >= 0 ? String(f[n.pruebas] || '').trim() : '',
      asesorNoct: n.asesor >= 0 ? String(f[n.asesor] || '').trim() : '' });
  }
  props.setProperty('CASOS_ULT_IMPORT', ahora_() + ' · ' + nuevos.length + ' nuevo(s)');
  if (!nuevos.length) return 'Nocturno: sin casos nuevos (desde ' + desde + ').' + (saltados ? ' ' + saltados + ' fila(s) sin número o fecha válidos.' : '');

  // Asignación: el que tenga menos casos abiertos, recibe casos = SI y no está fuera hoy
  const asesores = leerAsign_();
  const fuera = fueraHoy_(asesores);
  let cand = asesores.filter(function (a) { return a.recibe && !fuera[a.id]; });
  if (!cand.length) cand = asesores.filter(function (a) { return a.recibe; });
  if (!cand.length) cand = asesores;
  const carga = {};
  cand.forEach(function (a) { carga[a.id] = 0; });
  casos.filas.forEach(function (x) {
    const id = String(x.v[c.asesor] || '').trim().toUpperCase();
    if (id in carga && nc_(x.v[c.status]) !== 'CERRADO') carga[id]++;
  });
  let turno = +(props.getProperty('CASOS_TURNO') || 0);

  let folio = siguienteFolio_();
  const hoja = casos.hoja;
  const ancho = Math.max(c.folio, c.observacion, c.notas) + 1;
  // Primera fila libre (A..FOLIO vacías) después del último caso
  let ultima = casos.filas.length ? casos.filas[casos.filas.length - 1].fila : 1;
  const libre = function (r) { return r > hoja.getLastRow() || hoja.getRange(r, 1, 1, ancho).getValues()[0].every(function (x) { return x === '' || x === null; }); };
  const regFilas = [];
  nuevos.forEach(function (x) {
    let asesor = '';
    if (cand.length) {
      let mejor = null;
      for (let k = 0; k < cand.length; k++) {
        const a = cand[(turno + k) % cand.length];
        if (!mejor || carga[a.id] < carga[mejor.id]) mejor = a;
      }
      asesor = mejor.id; carga[asesor]++;
      turno = (cand.indexOf(mejor) + 1) % cand.length;
    }
    folio++;
    const fila = new Array(ancho).fill('');
    fila[c.fecha] = x.fecha;
    fila[c.usuario] = x.nombre;
    fila[c.tipo] = tipoDeFalla_(x.falla, tipos);
    fila[c.afectada] = Number(x.linea);
    fila[c.contacto] = Number(x.contacto);
    fila[c.asesor] = asesor;
    fila[c.status] = CASOS.statusNuevo;
    fila[c.folio] = folio_(folio);
    ultima++;
    while (!libre(ultima)) ultima++;
    if (ultima > hoja.getMaxRows()) hoja.insertRowsAfter(hoja.getMaxRows(), 20);
    const rango = hoja.getRange(ultima, 1, 1, ancho);
    if (ultima > 2) {   // mismo formato y listas desplegables que la fila 2
      hoja.getRange(2, 1, 1, ancho).copyTo(rango, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      hoja.getRange(2, 1, 1, ancho).copyTo(rango, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    }
    rango.setValues([fila]);
    const nota = 'NOCTURNO ' + fmt_(x.fecha) + (x.asesorNoct ? ' · ' + x.asesorNoct : '') + (x.falla ? ' · Falla: ' + x.falla : '') + (x.pruebas ? '\n\n' + x.pruebas : '');
    hoja.getRange(ultima, c.usuario + 1).setNote(nota);
    regFilas.push([x.clave, folio_(folio), new Date(), asesor]);
  });
  props.setProperty('CASOS_TURNO', String(turno));
  reg.getRange(reg.getLastRow() + 1, 1, regFilas.length, 4).setValues(regFilas);
  SpreadsheetApp.flush();
  return 'Nocturno: ' + nuevos.length + ' caso(s) nuevo(s): ' + regFilas.map(function (r) { return r[1] + '→' + (r[3] || 'sin asesor'); }).join(', ') +
    (Object.keys(fuera).length ? '\n(No se asignó a quien está fuera hoy: ' + Object.keys(fuera).join(', ') + ')' : '');
}

// ---------------------------------------------------------------------
// 2. Hoja → Firebase
// ---------------------------------------------------------------------
const CAMPOS_HOJA = ['folio', 'fecha', 'fechaYmd', 'usuario', 'tipo', 'lineaAfectada', 'lineaContacto', 'asesor', 'asesorNombre', 'asesorNomina',
  'status', 'ultimaAccion', 'fechaUltima', 'intentos', 'notas', 'observacion', 'detalle', 'claves', 'fila', 'actualizadoHoja'];

function casoDesdeFila_(x, c, porId, nota) {
  const v = x.v, val = function (k) { return c[k] >= 0 ? v[c[k]] : ''; };
  const txt = function (k) { const s = val(k); return s instanceof Date ? fmt_(s) : String(s == null ? '' : s).trim(); };
  const id = txt('asesor').toUpperCase(), a = porId[id] || {};
  const f = aFecha_(val('fecha')), fu = aFecha_(val('fechaUltima'));
  const intentos = Number(val('intentos'));
  const claves = [id, a.nomina, a.nombre ? claveNombre_(a.nombre) : ''].filter(String);
  return {
    folio: txt('folio'), fecha: fmt_(f) || txt('fecha'), fechaYmd: ymd_(f), usuario: txt('usuario'), tipo: txt('tipo'),
    lineaAfectada: linea_(val('afectada')), lineaContacto: linea_(val('contacto')),
    asesor: id, asesorNombre: a.nombre || '', asesorNomina: a.nomina || '',
    status: txt('status'), ultimaAccion: txt('accion'), fechaUltima: fu ? fmt_(fu) : txt('fechaUltima'),
    intentos: isNaN(intentos) || val('intentos') === '' ? null : intentos,
    notas: txt('notas'), observacion: txt('observacion'), detalle: nota || '',
    claves: claves, fila: x.fila, actualizadoHoja: Date.now()
  };
}

// Sin rango: toda la hoja (y borra de la página lo que ya no está en CASOS). Con rango: solo esas filas.
function sincronizarCasos_(r1, r2) {
  const casos = leerHojaCasos_(CASOS.hoja);
  if (!casos) return 'No encontré la pestaña ' + CASOS.hoja + '.';
  const c = casos.c;
  if (c.folio < 0) return 'La pestaña CASOS no tiene columna FOLIO.';
  let filas = casos.filas;
  if (r1) filas = filas.filter(function (x) { return x.fila >= r1 && x.fila <= r2; });

  // Filas sin folio (capturadas a mano): se les pone el siguiente
  const sinFolio = filas.filter(function (x) { return !String(x.v[c.folio]).trim() && String(x.v[c.usuario]).trim() && linea_(x.v[c.afectada]); });
  if (sinFolio.length) {
    let n = siguienteFolio_();
    sinFolio.forEach(function (x) { n++; x.v[c.folio] = folio_(n); casos.hoja.getRange(x.fila, c.folio + 1).setValue(x.v[c.folio]); });
  }

  const asesores = leerAsign_(), porId = {};
  asesores.forEach(function (a) { porId[a.id] = a; });
  const notas = c.usuario >= 0 && casos.filas.length ? casos.hoja.getRange(1, c.usuario + 1, casos.hoja.getLastRow(), 1).getNotes() : [];
  const docs = filas.filter(function (x) { return String(x.v[c.folio]).trim(); }).map(function (x) {
    return casoDesdeFila_(x, c, porId, (notas[x.fila - 1] || [''])[0]);
  });
  // Un folio repetido en la hoja: solo se manda el primero
  const vistos = {};
  const unicos = docs.filter(function (d) { if (vistos[d.folio]) return false; vistos[d.folio] = 1; return true; });
  fsGuardarVarios_(unicos.map(function (d) { return { id: d.folio, datos: d, campos: CAMPOS_HOJA }; }));

  let borrados = 0;
  if (!r1) {
    // Listas y asesores para la página
    fsGuardarVarios_([{ coleccion: 'hoja', id: 'casos_meta', datos: {
      tipos: listaDe_(casos.hoja, 2, c.tipo, CASOS.tipos),
      status: listaDe_(casos.hoja, 2, c.status, CASOS.status),
      acciones: listaDe_(casos.hoja, 2, c.accion, CASOS.acciones),
      asesores: asesores.map(function (a) { return { id: a.id, nombre: a.nombre, nomina: a.nomina, recibe: a.recibe }; }),
      actualizado: Date.now()
    } }]);
    // Lo que ya no está en CASOS (se cerró y se movió, o se borró) se quita de la página
    const enHoja = {};
    unicos.forEach(function (d) { enHoja[d.folio] = 1; });
    const sobran = fsListar_().filter(function (d) { return !enHoja[d.id] && !d.pendienteHoja; });
    fsBorrarVarios_(sobran.map(function (d) { return d.id; }));
    borrados = sobran.length;
    PropertiesService.getScriptProperties().setProperty('CASOS_ULT_SYNC', ahora_() + ' · ' + unicos.length + ' caso(s)');
  }
  return 'Página: ' + unicos.length + ' caso(s) actualizados' + (borrados ? ', ' + borrados + ' quitado(s)' : '') + (sinFolio.length ? ', ' + sinFolio.length + ' folio(s) nuevo(s)' : '') + '.';
}

// ---------------------------------------------------------------------
// 3. Página → hoja
// ---------------------------------------------------------------------
function aplicarPendientesWeb_() {
  const pend = fsPendientes_();
  if (!pend.length) return 'Página: sin cambios pendientes.';
  const casos = leerHojaCasos_(CASOS.hoja);
  const c = casos.c, hoja = casos.hoja;
  const porFolio = {};
  casos.filas.forEach(function (x) { const f = String(x.v[c.folio]).trim(); if (f && !porFolio[f]) porFolio[f] = x; });
  const asesores = leerAsign_(), porId = {};
  asesores.forEach(function (a) { porId[a.id] = a; });
  const listas = {
    status: listaDe_(hoja, 2, c.status, CASOS.status),
    ultimaAccion: listaDe_(hoja, 2, c.accion, CASOS.acciones)
  };
  const COL = { status: 'status', ultimaAccion: 'accion', fechaUltima: 'fechaUltima', intentos: 'intentos', notas: 'notas', observacion: 'observacion', asesor: 'asesor' };
  const notas = hoja.getRange(1, c.usuario + 1, hoja.getLastRow(), 1).getNotes();
  let hechos = 0;
  const salida = [];
  pend.forEach(function (p) {
    const x = porFolio[p.id];
    if (!x) {
      salida.push({ id: p.id, datos: { pendienteHoja: false, cambios: {}, errorHoja: 'Este caso ya no está en la pestaña CASOS; no se guardó en la hoja.' }, campos: ['pendienteHoja', 'cambios', 'errorHoja'], updateTime: p.updateTime });
      return;
    }
    const cam = p.cambios || {};
    Object.keys(cam).forEach(function (k) {
      if (!COL[k] || c[COL[k]] < 0) return;
      let v = cam[k];
      if (k === 'status' || k === 'ultimaAccion') { if (v !== '' && listas[k].indexOf(v) < 0) return; }
      if (k === 'asesor') { v = String(v || '').toUpperCase(); if (!porId[v]) return; }
      if (k === 'fechaUltima') v = aFecha_(v) || '';
      if (k === 'intentos') v = v === '' || v == null ? '' : Number(v);
      hoja.getRange(x.fila, c[COL[k]] + 1).setValue(v);
      x.v[c[COL[k]]] = v;
    });
    hechos++;
    const d = casoDesdeFila_(x, c, porId, (notas[x.fila - 1] || [''])[0]);
    d.pendienteHoja = false; d.cambios = {}; d.errorHoja = ''; d.sincronizadoHoja = Date.now();
    salida.push({ id: p.id, datos: d, campos: CAMPOS_HOJA.concat(['pendienteHoja', 'cambios', 'errorHoja', 'sincronizadoHoja']), updateTime: p.updateTime });
  });
  SpreadsheetApp.flush();
  fsGuardarVarios_(salida, true);
  PropertiesService.getScriptProperties().setProperty('CASOS_ULT_WEB', ahora_() + ' · ' + hechos + ' caso(s): ' + pend.map(function (p) { return p.id; }).join(', '));
  return 'Página → hoja: ' + hechos + ' caso(s) actualizados.';
}

// ---------------------------------------------------------------------
// Firebase (REST) — usa obtenerToken_() y CONFIG del archivo Pagina
// ---------------------------------------------------------------------
function fsBase_() { return 'https://firestore.googleapis.com/v1/projects/' + CONFIG.projectId + '/databases/(default)/documents'; }

function fsValor_(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValor_) } };
  if (v && typeof v === 'object') {
    const f = {};
    Object.keys(v).forEach(function (k) { f[k] = fsValor_(v[k]); });
    return { mapValue: { fields: f } };
  }
  return aFirestore_(v);
}

function deFs_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deFs_);
  if ('mapValue' in v) { const o = {}, f = v.mapValue.fields || {}; Object.keys(f).forEach(function (k) { o[k] = deFs_(f[k]); }); return o; }
  return null;
}

// docs: [{coleccion?, id, datos, campos?, updateTime?}]  — "campos" = solo esos campos (no borra los demás)
function fsGuardarVarios_(docs, toleraConflicto) {
  if (!docs.length) return;
  const token = obtenerToken_();
  for (let i = 0; i < docs.length; i += 40) {
    const reqs = docs.slice(i, i + 40).map(function (d) {
      const fields = {};
      Object.keys(d.datos).forEach(function (k) { fields[k] = fsValor_(d.datos[k]); });
      let url = fsBase_() + '/' + (d.coleccion || CASOS.coleccion) + '/' + encodeURIComponent(d.id);
      const q = (d.campos || []).map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); });
      if (d.updateTime) q.push('currentDocument.updateTime=' + encodeURIComponent(d.updateTime));
      if (q.length) url += '?' + q.join('&');
      return { url: url, method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
               headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify({ fields: fields }) };
    });
    UrlFetchApp.fetchAll(reqs).forEach(function (r) {
      const code = r.getResponseCode();
      if (code >= 300 && !(toleraConflicto && (code === 400 || code === 409) && /FAILED_PRECONDITION|ABORTED/.test(r.getContentText()))) {
        throw new Error('Firebase ' + code + ': ' + r.getContentText().slice(0, 300));
      }
    });
  }
}

function fsBorrarVarios_(ids) {
  if (!ids.length) return;
  const token = obtenerToken_();
  UrlFetchApp.fetchAll(ids.map(function (id) {
    return { url: fsBase_() + '/' + CASOS.coleccion + '/' + encodeURIComponent(id), method: 'delete', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } };
  }));
}

function fsListar_() {
  const out = [], token = obtenerToken_();
  let page = '';
  do {
    const r = UrlFetchApp.fetch(fsBase_() + '/' + CASOS.coleccion + '?pageSize=300&mask.fieldPaths=pendienteHoja' + (page ? '&pageToken=' + encodeURIComponent(page) : ''),
      { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } });
    if (r.getResponseCode() >= 300) throw new Error('Firebase ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
    const j = JSON.parse(r.getContentText());
    (j.documents || []).forEach(function (d) {
      out.push({ id: decodeURIComponent(d.name.split('/').pop()), pendienteHoja: deFs_((d.fields || {}).pendienteHoja) === true });
    });
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

function fsPendientes_() {
  const r = UrlFetchApp.fetch(fsBase_() + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + obtenerToken_() },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: CASOS.coleccion }],
      where: { fieldFilter: { field: { fieldPath: 'pendienteHoja' }, op: 'EQUAL', value: { booleanValue: true } } },
      limit: 100
    } })
  });
  if (r.getResponseCode() >= 300) throw new Error('Firebase ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText()).filter(function (x) { return x.document; }).map(function (x) {
    const f = x.document.fields || {};
    return { id: decodeURIComponent(x.document.name.split('/').pop()), cambios: deFs_(f.cambios) || {}, updateTime: x.document.updateTime };
  });
}
