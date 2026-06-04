@echo off

start "nervhq" powershell -NoExit -Command "cd C:\Users\kiyor\Documents\GitHub\WEB-PROJEKT-2A-BRAIK\nervhq; pnpm dev"

start "files-api" powershell -NoExit -Command "cd C:\Users\kiyor\Documents\GitHub\WEB-PROJEKT-2A-BRAIK\files; node server.js"

start "files-static" powershell -NoExit -Command "cd C:\Users\kiyor\Documents\GitHub\WEB-PROJEKT-2A-BRAIK\files; npx serve . -l 8080"