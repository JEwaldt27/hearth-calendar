@echo off
rem Runs deploy.ps1 without needing to change PowerShell's script execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
