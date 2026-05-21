@echo off
REM ============================================================
REM  Dropwise - build .exe desktop (PyInstaller + pywebview)
REM  Ruleaza:  build_exe.bat
REM  Rezultat: dist\Dropwise\Dropwise.exe  (trimite tot folderul)
REM ============================================================

echo Instalare dependinte build...
pip install pyinstaller pywebview

echo.
echo Curatare build anterior...
if exist build  rmdir /s /q build
if exist dist   rmdir /s /q dist

echo.
echo Build in curs...
pyinstaller --onedir --windowed --name Dropwise ^
  --icon "static\favicon.ico" ^
  --add-data "templates;templates" ^
  --add-data "static;static" ^
  --add-data ".env.example;." ^
  --hidden-import bleak ^
  --hidden-import bleak.backends.winrt ^
  run_app.py

echo.
echo ============================================================
echo  Gata. Executabilul: dist\Dropwise\Dropwise.exe
echo  Trimite tot folderul dist\Dropwise (arhivat zip).
echo ============================================================
pause
