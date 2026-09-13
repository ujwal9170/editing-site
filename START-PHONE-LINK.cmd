@echo off
setlocal enabledelayedexpansion
title web-editor - phone link
cd /d "%~dp0"

echo ============================================
echo   web-editor  -  phone link
echo ============================================
echo.
echo   1. main pull   2. patch   3. dependencies
echo   4. account     5. HTTPS link phone ke liye
echo.
echo   Aapke local changes git stash me ja rahe hain
echo   (wapas chahiye to baad me:  git stash pop).
echo.

rem ---------- zaroori cheezein ----------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo [X] Node nahi mila.
  echo     PowerShell me chalao:  winget install OpenJS.NodeJS.LTS
  goto :dead
)
where git >nul 2>&1
if errorlevel 1 (
  echo [X] Git nahi mila.
  echo     PowerShell me chalao:  winget install Git.Git
  goto :dead
)
if not exist "scripts\dev.mjs" (
  echo [X] Galat folder. Ye file web-editor folder ke andar honi chahiye.
  goto :dead
)
if not exist "phone-video-space.patch" (
  echo [X] phone-video-space.patch nahi mila is folder me.
  goto :dead
)
if not exist "phone-link.mjs" (
  echo [X] phone-link.mjs nahi mila is folder me.
  goto :dead
)

echo.
echo --- 1/5  main pull ----------------------------------------
git stash push -m "before phone-video-space" >nul 2>&1
git checkout main
if errorlevel 1 (
  echo [X] main pe switch nahi ho paya.
  goto :dead
)
git pull --ff-only
if errorlevel 1 (
  echo [X] Pull nahi hua. Shayad main pe aapke apne commits hain jo push nahi hue.
  echo     Ek baar ye chala ke dekho:   git status
  goto :dead
)

echo.
echo --- 2/5  patch --------------------------------------------
git rev-parse --verify feat/phone-video-space >nul 2>&1
if errorlevel 1 goto :newbranch

git checkout feat/phone-video-space
if errorlevel 1 (
  echo [X] Branch pe switch nahi ho paya.
  goto :dead
)
rem Branch purane main se bani ho sakti hai. Uspe apna koi commit na ho to
rem usse naye main ke barabar kar do, warna patch fit nahi hoga.
git merge-base --is-ancestor feat/phone-video-space main >nul 2>&1
if errorlevel 1 goto :patchstep
git merge --ff-only main
echo     Branch ko naye main ke barabar kar diya.
goto :patchstep

:newbranch
git checkout -b feat/phone-video-space
if errorlevel 1 (
  echo [X] Branch nahi ban payi.
  goto :dead
)

:patchstep
git apply --check --reverse phone-video-space.patch >nul 2>&1
if not errorlevel 1 (
  echo     Patch pehle se laga hua hai - skip.
  goto :deps
)
git apply --check phone-video-space.patch
if errorlevel 1 (
  echo.
  echo [X] Patch apply nahi ho raha - upar git ne wajah batayi hai.
  echo     Reset karke dobara try karne ke liye:
  echo         git checkout main
  echo         git branch -D feat/phone-video-space
  echo     phir ye file dobara double-click karo.
  goto :dead
)
git apply phone-video-space.patch
if errorlevel 1 (
  echo [X] Patch apply hote hue fail ho gaya.
  goto :dead
)
rem -u = sirf tracked files, taaki ye scripts commit me na chali jayein.
git add -u
git -c user.name="ujwal9170" -c user.email="s70241249@gmail.com" commit -q -m "Phone editor: pan gesture, slim transport, Clips tab"
echo     Patch lag gaya aur commit ho gaya.

:deps
rem Phone-testing tooling bhi repo me rahe. .gitignore me .tools/ aur *.patch
rem hain, toh cloudflared ki 50 MB exe aur transient patch file kabhi commit
rem nahi hongi. Label ke BAAD rakha hai, kyunki "patch pehle se laga hai" wala
rem raasta seedha yahin kudta hai.
git add .gitignore START-PHONE-LINK.cmd phone-link.mjs >nul 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git -c user.name="ujwal9170" -c user.email="s70241249@gmail.com" commit -q -m "Add phone-testing tooling: cloudflared tunnel launcher for HTTPS on device"
  echo     Tooling commit ho gayi.
)

rem Push aapki machine se hi hota hai -- cloud session ke paas is repo ka GitHub
rem credential nahi hai. Fail ho to rukna nahi: link banana zyada zaroori hai.
echo     GitHub pe push kar rahe hain...
git push -u origin feat/phone-video-space
if errorlevel 1 (
  echo     [!] Push nahi hua. Shayad GitHub login chahiye - ek window khul sakti
  echo         hai, ya baad me khud chala lena:
  echo             git push -u origin feat/phone-video-space
  echo         Baaki sab aage chalta rahega.
) else (
  echo     Push ho gaya.
)

echo.
echo --- 3/5  dependencies -------------------------------------
set "PM_OK="
where pnpm >nul 2>&1
if not errorlevel 1 (
  call pnpm install --frozen-lockfile && set "PM_OK=1"
)
if not defined PM_OK (
  echo     pnpm PATH pe nahi mila - npx se chala rahe hain...
  call npx --yes pnpm@10.15.1 install --frozen-lockfile && set "PM_OK=1"
)
if not defined PM_OK (
  echo [X] Dependencies install nahi hui.
  goto :dead
)

rem Purane next.config.mjs wale LAN origins ab .env me rehte hain.
if exist ".env" (
  findstr /b /i /c:"DEV_ORIGINS=" ".env" >nul 2>&1
  if errorlevel 1 (>>".env" echo DEV_ORIGINS=192.168.29.131,192.168.29.*)
)

echo.
echo --- 4/5  account ------------------------------------------
rem HOST loopback nahi hai, aur tab server bina account ke start hi nahi hota.
rem Koi sawal nahi poochhte -- script bina keyboard ke chalni chahiye -- isliye
rem ek temporary account bana dete hain aur password screen pe likh dete hain.
set "TEMP_ACCOUNT="
"%NODE_EXE%" scripts\user.mjs list > "%TEMP%\we-users.txt" 2>&1
type "%TEMP%\we-users.txt"
findstr /c:"No accounts yet" "%TEMP%\we-users.txt" >nul 2>&1
if not errorlevel 1 (
  "%NODE_EXE%" scripts\user.mjs add ujjwal phone-test-1234
  if errorlevel 1 (
    echo [X] Account nahi bana.
    goto :dead
  )
  set "TEMP_ACCOUNT=1"
)
del "%TEMP%\we-users.txt" >nul 2>&1

echo.
echo --- 5/5  phone link ---------------------------------------
rem Port .env se phone-link.mjs khud padh leta hai.
if not exist ".tools\cloudflared.exe" (
  echo     cloudflared download ho raha hai ^(~50 MB, sirf pehli baar^)...
  if not exist ".tools" mkdir ".tools"
  curl.exe -L --fail --progress-bar -o ".tools\cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  if errorlevel 1 (
    del ".tools\cloudflared.exe" >nul 2>&1
    echo [X] cloudflared download nahi hua.
    echo     Ye link browser me kholo, file ko .tools\cloudflared.exe naam se save karo,
    echo     phir ye script dobara chalao:
    echo     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
    goto :dead
  )
)

if defined TEMP_ACCOUNT (
  echo.
  echo     Naya account bana hai - sign in karne ke liye:
  echo         username: ujjwal
  echo         password: phone-test-1234
  echo     Password badalne ke liye:  node scripts\user.mjs passwd ujjwal
  echo.
)

rem Tunnel, .env update aur dev server -- sab phone-link.mjs ke andar. Batch me
rem cloudflared ka output parse karna do baar toot chuka hai (paths with spaces,
rem delayed expansion, file locking); Node me ye sab problem hi nahi hai.
"%NODE_EXE%" phone-link.mjs
taskkill /f /im cloudflared.exe >nul 2>&1
echo.
echo ============================================
echo   Server aur tunnel dono band ho gaye.
echo ============================================
echo.
pause
goto :eof

:dead
echo.
echo ============================================
echo   Ruk gaya. Upar ki [X] line padho.
echo ============================================
echo.
pause
exit /b 1
