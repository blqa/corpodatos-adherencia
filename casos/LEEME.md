# Casos · omt.godsplan.site/casos

Página donde cada asesor ve **solo sus casos asignados** de la pestaña CASOS del documento OMT, y el supervisor ve todos.

## Cómo fluye todo

```
Fallas e inconsistencias_NOCTURNO ──(cada 10 min)──► pestaña CASOS (documento OMT)
                                                        ▲        │
                                         (~1 minuto)    │        │  (al editar, al momento)
                                                        │        ▼
                                              omt.godsplan.site/casos  (Firebase: colección "casos")
```

- **Casos nuevos del nocturno**: el script `apps-script/Casos.gs` los copia a CASOS con folio `OMT-xxxxx`,
  tipo de caso, status *Pendiente* y asesor asignado. Se asigna al que tenga **menos casos abiertos**, que tenga
  **¿RECIBE CASOS? = SI** en ASIGN y que **no esté de descanso, vacaciones o permiso hoy** (lo decide `asignarFilas_`
  del archivo principal).
  Lo que escribió el nocturno (PRUEBAS) queda como **nota** en la celda USUARIO y se ve en la página.
- **No repite casos**: si el número afectado ya está en CASOS, H_CASOS o CASOS_ANTIGUOS con una fecha de 7 días
  o menos (o sin fecha), no lo vuelve a meter. La primera vez solo trae casos desde la fecha más reciente que ya
  tenías (menú 📋 Casos → *Cambiar desde qué fecha se importa* para moverla).
- **Hoja → página**: lo que cambies a mano en CASOS aparece en la página al momento. Si un caso sale de CASOS
  (lo mueves a H_CASOS), desaparece de la página.
- **Página → hoja**: lo que el asesor guarda (status, última acción, intentos, notas) se escribe en CASOS en ~1 minuto
  (de 6:00 a 23:00). El supervisor además puede cambiar el asesor y la observación.

## Instalar (una sola vez)

1. **Reglas de Firebase** (Firestore → Reglas). Dentro de `match /databases/{database}/documents { … }` agrega:

   ```
   function hojaOSuper() {
     return request.auth != null &&
            request.auth.token.email in ['hoja@omt.godsplan.site', '17620@omt.godsplan.site'];
   }
   match /casos/{folio} {
     allow read: if true;
     allow create, delete: if hojaOSuper();
     allow update: if hojaOSuper() || (
       request.resource.data.diff(resource.data).affectedKeys().hasOnly(
         ['status', 'ultimaAccion', 'fechaUltima', 'intentos', 'notas',
          'cambios', 'pendienteHoja', 'errorHoja', 'editadoPor', 'editadoEn']) &&
       request.resource.data.cambios.keys().hasOnly(
         ['status', 'ultimaAccion', 'fechaUltima', 'intentos', 'notas']));
   }
   ```
   Y revisa que `hoja/casos_meta` se pueda leer (igual que `hoja/rol`) y que `hoja@omt.godsplan.site` pueda escribir en `hoja`.

2. **Script en el documento OMT**: Extensiones → Apps Script → **+** → Secuencia de comandos → `Casos`,
   pega `apps-script/Casos.gs` y guarda. Necesita el archivo `Pagina` que ya tienes (usa su contraseña).
3. En el archivo principal (el del menú "OMT"), dentro de `onOpen()`, debajo de
   `if (typeof menuPagina_ === 'function') menuPagina_();` agrega:
   ```
   if (typeof menuCasos_ === 'function') menuCasos_();
   ```
   y recarga la hoja. La asignación de asesor y folio de los casos del nocturno la hace la misma función
   `asignarFilas_` del archivo principal, así que se siguen las mismas reglas de siempre (ROL, VACACIONES,
   ¿RECIBE CASOS?, menos casos abiertos). El archivado a H_CASOS también sigue igual.
4. Menú **📋 Casos → 1. Activar casos automáticos** y acepta los permisos.

## Ojo

- Los asesores entran con su ID (como en su página de adherencia). Como no hay contraseña, alguien que escriba
  el ID de otro podría ver sus casos; la página solo **pide** los casos del asesor que inició sesión.
- Las opciones de STATUS, ÚLTIMA ACCIÓN y TIPO DE CASO se toman de las listas desplegables de la fila 2 de CASOS.
  Si las cambias en la hoja, la página las usa solas.
