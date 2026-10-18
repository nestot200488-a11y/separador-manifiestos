@echo off
title Procesador de Manifiestos PDF
echo =======================================================
echo Iniciando Servidor de Procesamiento de Manifiestos...
echo =======================================================
start http://localhost:3000
node server.mjs
pause
