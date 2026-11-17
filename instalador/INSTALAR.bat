@echo off
title Instalar Tracker Agentes
color 1F

rem ============================================================
rem  Instalador de la extension Tracker Agentes (OMT Corpodatos)
rem  La extension vive SIEMPRE en esta carpeta de red:
rem ============================================================
set "EXT=\\10.202.79.7\Telcel_Corpo\SUPER\LUIS\tracker-agentes\tracker-agentes"

if not exist "%EXT%\manifest.json" (
    color 4F
    echo.
    echo  No encuentro la extension en:
    echo  %EXT%
    echo.
    echo  Revisa que esta PC tenga acceso a la carpeta de red y vuelve a intentar.
    echo.
    pause
    exit /b 1
)

rem Copia la ruta al portapapeles (sin salto de linea) para pegarla en Chrome
<nul set /p "=%EXT%" | clip

rem Abre Chrome en la pagina de extensiones
start "" chrome "chrome://extensions"

cls
echo.
echo  =============================================================
echo    INSTALAR TRACKER AGENTES  (1 minuto)
echo  =============================================================
echo.
echo   Ya abri Chrome en la pagina de extensiones y COPIE la ruta.
echo   (Si no se abrio, escribe  chrome://extensions  en Chrome)
echo.
echo   1. Arriba a la derecha, activa  "Modo de desarrollador".
echo.
echo   2. Si ya tienes "Tracker Agentes" instalada, dale  "Quitar".
echo.
echo   3. Da clic en  "Cargar descomprimida".
echo.
echo   4. En la ventana que se abre, haz clic en la barra de
echo      "Carpeta:" de abajo, pega con  Ctrl + V  y da clic en
echo      "Seleccionar carpeta".
echo.
echo   5. Abre Touchpoint, da clic al icono de la extension
echo      (la pieza de rompecabezas, y fijala con el alfiler),
echo      escribe TU ID y guarda.
echo.
echo   6. En el popup, "Estado de la extension" debe decir
echo      "Conectada" en verde.
echo.
echo  -------------------------------------------------------------
echo   Ruta copiada:
echo   %EXT%
echo  =============================================================
echo.
pause
