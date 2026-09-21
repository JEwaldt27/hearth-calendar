@echo off
rem Copies Hearth's database backups from the server to the "backups" folder here.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pull-backups.ps1" %*
