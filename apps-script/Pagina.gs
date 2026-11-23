/**
 * =====================================================================
 *  OMT → Página web (omt.godsplan.dev/documento.html)
 *  Copia SOLO las pestañas PRODUCTIVIDAD, ADHERENCIA y ROL a Firebase
 *  una vez al día, a las 12:00 (hora de CDMX). Lo demás del documento
 *  (scripts, autenticación, aplicativos, directorio) ya vive en la página.
 *
 *  Cómo se usa (una sola vez):
 *    1. En Extensiones → Apps Script crea un archivo nuevo (+ → Secuencia
 *       de comandos) llamado Pagina, pega este código y guarda.
 *    2. En el onOpen() del otro archivo agrega la línea  menuPagina_();
 *       y recarga la hoja: aparecen los menús "OMT" y "🌐 Página OMT".
 *    3. 🌐 Página OMT → "1. Configurar contraseña" (la del usuario
 *       hoja@omt.godsplan.site que creaste en Firebase).
 *    4. 🌐 Página OMT → "2. Activar actualización diaria".
 *  Si cambias algo y no quieres esperar a las 12, usa "Actualizar ahora".
 * =====================================================================
 */

const CONFIG = {
  apiKey: 'AIzaSyBKYconuZXn53Eb4EJFsHj4rYaO0eK6liQ',
  projectId: 'tratocom-d38e7',
  email: 'hoja@omt.godsplan.site',
  coleccion: 'hoja',
  hora: 12,
  zona: 'America/Mexico_City',
  // pestaña de la hoja → documento en Firebase
  pestanas: { 'PRODUCTIVIDAD': 'productividad', 'ADHERENCIA': 'adherencia', 'ROL': 'rol' }
};

// ---------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------
// OJO: este archivo NO tiene onOpen propio, porque en la hoja ya existe
// otro script con su menú "OMT". Ese onOpen llama a menuPagina_().
function menuPagina_() {
  SpreadsheetApp.getUi().createMenu('🌐 Página OMT')
    .addItem('1. Configurar contraseña', 'configurarContrasena')
    .addItem('2. Activar actualización diaria (12:00)', 'activarDiario')
    .addSeparator()
    .addItem('Actualizar ahora', 'actualizarAhora')
    .addItem('Ver estado', 'verEstado')
    .addItem('Desactivar actualización diaria', 'desactivarDiario')
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
    ui.alert('✅ Contraseña correcta. Ahora usa "2. Activar actualización diaria".');
  } catch (e) {
    ui.alert('❌ No se pudo iniciar sesión: ' + e.message);
  }
}

function activarDiario() {
  desactivarDiario(true);
  ScriptApp.newTrigger('sincronizarDiario').timeBased().everyDays(1).atHour(CONFIG.hora).inTimezone(CONFIG.zona).create();
  const res = sincronizarDiario();
  SpreadsheetApp.getUi().alert('✅ Actualización diaria activada.\n\nCada día entre las 12:00 y las 12:59 se copian Productividad, Adherencia y Rol a la página.\n\nPrimera copia de una vez:\n' + res);
}

function desactivarDiario(silencioso) {
  // También borra los activadores viejos de la versión "en vivo"
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['sincronizarDiario', 'alEditar', 'alCambiar', 'sincronizarTodo'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  if (silencioso !== true) SpreadsheetApp.getUi().alert('Actualización diaria desactivada.');
}

function actualizarAhora() {
  SpreadsheetApp.getUi().alert(sincronizarDiario());
}

function verEstado() {
  const p = PropertiesService.getScriptProperties();
  const activo = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sincronizarDiario'; });
  SpreadsheetApp.getUi().alert(
    'Actualización diaria: ' + (activo ? '✅ activa (12:00)' : '⛔ apagada') + '\n' +
    'Contraseña: ' + (p.getProperty('PASS') ? 'configurada' : 'FALTA') + '\n' +
    'Última copia: ' + (p.getProperty('ULTIMA_SYNC') || 'nunca') + '\n' +
    'Último error: ' + (p.getProperty('ULTIMO_ERROR') || 'ninguno'));
}

// ---------------------------------------------------------------------
// Copia diaria
// ---------------------------------------------------------------------
function normal_(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim(); }

function sincronizarDiario() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return 'Ya había una copia en curso.';
  try {
    const hojas = SpreadsheetApp.getActive().getSheets();
    const ahora = new Date().toISOString();
    const hechas = [], faltan = [];
    Object.keys(CONFIG.pestanas).forEach(function (nombre) {
      const hoja = hojas.filter(function (h) { return normal_(h.getName()) === nombre; })[0];
      if (!hoja) { faltan.push(nombre); return; }
      const d = leerHoja_(hoja);
      escribirDoc_(CONFIG.pestanas[nombre], {
        titulo: hoja.getName(),
        filas: JSON.stringify(d.filas),
        filasCongeladas: hoja.getFrozenRows(),
        actualizado: ahora
      });
      hechas.push(hoja.getName() + ' (' + d.filas.length + ' filas)');
    });
    const res = 'Copiadas: ' + (hechas.join(', ') || 'ninguna') + (faltan.length ? '\nNo encontré la pestaña: ' + faltan.join(', ') : '');
    PropertiesService.getScriptProperties().setProperty('ULTIMA_SYNC', new Date().toLocaleString('es-MX', { timeZone: CONFIG.zona }) + ' · ' + res);
    if (!faltan.length) PropertiesService.getScriptProperties().deleteProperty('ULTIMO_ERROR');
    else registrarError_('Faltan pestañas: ' + faltan.join(', '));
    return res;
  } catch (e) {
    registrarError_(e);
    return '❌ Error: ' + e.message;
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

function registrarError_(err) {
  PropertiesService.getScriptProperties().setProperty('ULTIMO_ERROR', new Date().toLocaleString('es-MX') + ' · ' + (err && err.message ? err.message : err));
  console.error(err);
}
