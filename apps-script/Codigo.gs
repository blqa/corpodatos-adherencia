/**
 * =====================================================================
 *  OMT → Página web (omt.godsplan.site)
 *  Copia cada pestaña de esta hoja a Firebase para que la página la
 *  muestre EN VIVO. Solo escribe las pestañas que cambiaron.
 *
 *  Cómo se usa (una sola vez):
 *    1. Pega este código en Extensiones → Apps Script y guarda.
 *    2. Recarga la hoja: aparece el menú "🌐 Página OMT".
 *    3. 🌐 Página OMT → "1. Configurar contraseña" (la del usuario
 *       hoja@omt.godsplan.site que creaste en Firebase).
 *    4. 🌐 Página OMT → "2. Activar sincronización automática".
 *  Listo: cada vez que edites, la página se actualiza sola.
 * =====================================================================
 */

const CONFIG = {
  apiKey: 'AIzaSyBKYconuZXn53Eb4EJFsHj4rYaO0eK6liQ',
  projectId: 'tratocom-d38e7',
  email: 'hoja@omt.godsplan.site',
  coleccion: 'hoja',
  maxCaracteres: 900000,   // Firestore permite ~1 MB por documento
  minutosRevision: 10      // revisión periódica (para pestañas con fórmulas que cambian solas)
};

// ---------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🌐 Página OMT')
    .addItem('1. Configurar contraseña', 'configurarContrasena')
    .addItem('2. Activar sincronización automática', 'activarSincronizacion')
    .addSeparator()
    .addItem('Sincronizar todo ahora', 'sincronizarTodoForzado')
    .addItem('Ver estado', 'verEstado')
    .addItem('Desactivar sincronización', 'desactivarSincronizacion')
    .addToUi();
}

function configurarContrasena() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Contraseña de sincronización',
    'Escribe la contraseña del usuario ' + CONFIG.email + ' (la que pusiste al crearlo en Firebase → Authentication).',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const pass = r.getResponseText().trim();
  if (!pass) return;
  PropertiesService.getScriptProperties().setProperty('PASS', pass);
  CacheService.getScriptCache().remove('TOKEN');
  try {
    obtenerToken_();
    ui.alert('✅ Contraseña correcta. Ahora usa "2. Activar sincronización automática".');
  } catch (e) {
    ui.alert('❌ No se pudo iniciar sesión: ' + e.message);
  }
}

function activarSincronizacion() {
  desactivarSincronizacion(true);
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('alEditar').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('alCambiar').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('sincronizarTodo').timeBased().everyMinutes(CONFIG.minutosRevision).create();
  const res = sincronizarTodoForzado(true);
  SpreadsheetApp.getUi().alert('✅ Sincronización activada.\n\n' + res + '\n\nDesde ahora cada edición se refleja en la página en segundos.');
}

function desactivarSincronizacion(silencioso) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['alEditar', 'alCambiar', 'sincronizarTodo'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  if (silencioso !== true) SpreadsheetApp.getUi().alert('Sincronización desactivada.');
}

function verEstado() {
  const p = PropertiesService.getScriptProperties();
  const ult = p.getProperty('ULTIMA_SYNC');
  const err = p.getProperty('ULTIMO_ERROR');
  const triggers = ScriptApp.getProjectTriggers().length;
  SpreadsheetApp.getUi().alert(
    'Sincronización: ' + (triggers ? 'ACTIVA' : 'apagada') + '\n' +
    'Última sincronización: ' + (ult || 'nunca') + '\n' +
    (err ? '\nÚltimo error: ' + err : 'Sin errores.'));
}

// ---------------------------------------------------------------------
// Disparadores
// ---------------------------------------------------------------------
function alEditar(e) {
  // Solo la pestaña que se editó: es lo más rápido
  try { sincronizarHojas_([e.range.getSheet()], false); } catch (err) { registrarError_(err); }
}
function alCambiar(e) {
  // Agregar/borrar/renombrar pestañas, pegar grandes bloques, etc.
  if (e && ['INSERT_GRID', 'REMOVE_GRID', 'OTHER', 'INSERT_ROW', 'REMOVE_ROW', 'INSERT_COLUMN', 'REMOVE_COLUMN'].indexOf(e.changeType) >= 0) sincronizarTodo();
}
function sincronizarTodo() {
  try { return sincronizarHojas_(SpreadsheetApp.getActive().getSheets(), false, true); } catch (err) { registrarError_(err); }
}
function sincronizarTodoForzado(silencioso) {
  const res = sincronizarHojas_(SpreadsheetApp.getActive().getSheets(), true, true);
  if (silencioso !== true) SpreadsheetApp.getUi().alert('✅ ' + res);
  return res;
}

// ---------------------------------------------------------------------
// Núcleo
// ---------------------------------------------------------------------
function sincronizarHojas_(hojas, forzar, actualizarIndice) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 'Otra sincronización estaba en curso.';
  try {
    const props = PropertiesService.getScriptProperties();
    const hashes = JSON.parse(props.getProperty('HASHES') || '{}');
    let escritas = 0;

    hojas.forEach(function (hoja) {
      const datos = leerHoja_(hoja);
      const json = JSON.stringify(datos.filas);
      const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, json + '|' + hoja.getName()));
      const id = String(hoja.getSheetId());
      if (!forzar && hashes[id] === hash) return;

      let filasJson = json, recortada = false;
      if (filasJson.length > CONFIG.maxCaracteres) {
        // Pestaña demasiado grande: se envían las primeras filas que quepan
        let filas = datos.filas.slice();
        while (filasJson.length > CONFIG.maxCaracteres && filas.length > 1) { filas = filas.slice(0, Math.floor(filas.length * 0.9)); filasJson = JSON.stringify(filas); }
        recortada = true;
      }
      escribirDoc_(id, {
        titulo: hoja.getName(),
        orden: hoja.getIndex(),
        filas: filasJson,                 // texto JSON (Firestore no permite listas de listas)
        filasCongeladas: hoja.getFrozenRows(),
        totalFilas: datos.filas.length,
        recortada: recortada,
        oculta: hoja.isSheetHidden(),
        actualizado: Date.now()
      });
      hashes[id] = hash;
      escritas++;
    });

    if (actualizarIndice) {
      const todas = SpreadsheetApp.getActive().getSheets();
      const indice = todas.map(function (h) { return { id: String(h.getSheetId()), titulo: h.getName(), orden: h.getIndex(), oculta: h.isSheetHidden() }; });
      const ids = indice.map(function (x) { return x.id; });
      // Olvida las pestañas que ya no existen
      Object.keys(hashes).forEach(function (k) { if (ids.indexOf(k) < 0) { delete hashes[k]; borrarDoc_(k); } });
      const idxJson = JSON.stringify(indice);
      if (forzar || props.getProperty('INDICE') !== idxJson) {
        escribirDoc_('_indice', { pestanas: idxJson, documento: SpreadsheetApp.getActive().getName(), actualizado: Date.now() });
        props.setProperty('INDICE', idxJson);
        escritas++;
      }
    }

    props.setProperty('HASHES', JSON.stringify(hashes));
    props.setProperty('ULTIMA_SYNC', new Date().toLocaleString('es-MX'));
    props.deleteProperty('ULTIMO_ERROR');
    return escritas + ' documento(s) actualizados en la página.';
  } finally {
    lock.releaseLock();
  }
}

// Lee los valores tal como se ven en pantalla, sin filas/columnas vacías al final
function leerHoja_(hoja) {
  const rango = hoja.getDataRange();
  let v = rango.getDisplayValues();
  // Quitar filas vacías al final
  while (v.length && v[v.length - 1].every(function (c) { return c === ''; })) v.pop();
  // Quitar columnas vacías a la derecha
  let maxCol = 0;
  v.forEach(function (fila) { for (let c = fila.length - 1; c >= 0; c--) { if (fila[c] !== '') { maxCol = Math.max(maxCol, c + 1); break; } } });
  v = v.map(function (fila) {
    const f = fila.slice(0, maxCol);
    while (f.length && f[f.length - 1] === '') f.pop(); // ahorra espacio
    return f;
  });
  return { filas: v };
}

// ---------------------------------------------------------------------
// Firebase (REST)
// ---------------------------------------------------------------------
function obtenerToken_() {
  const cache = CacheService.getScriptCache();
  const enCache = cache.get('TOKEN');
  if (enCache) return enCache;
  const pass = PropertiesService.getScriptProperties().getProperty('PASS');
  if (!pass) throw new Error('Falta configurar la contraseña (menú 🌐 Página OMT → 1).');
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + CONFIG.apiKey, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ email: CONFIG.email, password: pass, returnSecureToken: true })
  });
  const j = JSON.parse(r.getContentText());
  if (!j.idToken) throw new Error((j.error && j.error.message) || 'respuesta inesperada');
  cache.put('TOKEN', j.idToken, 50 * 60); // el token dura 60 min
  return j.idToken;
}

function aFirestore_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function escribirDoc_(id, datos) {
  const fields = {};
  Object.keys(datos).forEach(function (k) { fields[k] = aFirestore_(datos[k]); });
  const url = 'https://firestore.googleapis.com/v1/projects/' + CONFIG.projectId + '/databases/(default)/documents/' + CONFIG.coleccion + '/' + encodeURIComponent(id);
  const r = UrlFetchApp.fetch(url, {
    method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + obtenerToken_() },
    payload: JSON.stringify({ fields: fields })
  });
  if (r.getResponseCode() >= 300) throw new Error('Firebase ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
}

function borrarDoc_(id) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + CONFIG.projectId + '/databases/(default)/documents/' + CONFIG.coleccion + '/' + encodeURIComponent(id);
  UrlFetchApp.fetch(url, { method: 'delete', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + obtenerToken_() } });
}

function registrarError_(err) {
  PropertiesService.getScriptProperties().setProperty('ULTIMO_ERROR', new Date().toLocaleString('es-MX') + ' · ' + (err && err.message ? err.message : err));
  console.error(err);
}
