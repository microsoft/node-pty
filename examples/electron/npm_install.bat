@echo off
setlocal
set npm_config_disturl="https://atom.io/download/electron"
set npm_config_target=1.7.11
set npm_config_runtime="electron"
set npm_config_cache=~\.npm-electron
npm i
endlocal
