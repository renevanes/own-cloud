@echo off
rem Dubbelklik om de Eigen Cloud-beheerconsole te starten (Windows).
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run beheer
