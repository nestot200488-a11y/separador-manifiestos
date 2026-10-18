@echo off
title Subir codigo a GitHub
echo =======================================================
echo Subiendo repositorio a GitHub:
echo https://github.com/nestot200488-a11y/separdor-manofiestos.git
echo =======================================================
"C:\Users\Usuario1\.mingit\cmd\git.exe" push -u origin main
echo.
if %errorlevel% neq 0 (
  echo -----------------------------------------------------
  echo Si te pide contrasenia, recuerda que GitHub requiere un
  echo Personal Access Token (PAT).
  echo Puedes generarlo en: https://github.com/settings/tokens
  echo -----------------------------------------------------
) else (
  echo =====================================================
  echo CODIGO SUBIDO CON EXITO A GITHUB!
  echo =====================================================
)
pause
