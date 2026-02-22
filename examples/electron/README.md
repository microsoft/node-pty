This is a minimal example of getting a terminal running in Electron using [node-pty](https://github.com/microsoft/node-pty) and [xterm.js](https://github.com/xtermjs/xterm.js).

![](./images/preview.png)

It works by using xterm.js on the renderer process and node-pty on the main process with IPC to communicate back and forth.

## Usage

```bash
# Install dependencies (Windows)
./npm-install.bat

# Install dependencies (non-Windows)
./npm-install.sh

# Launch the app
npm start
```
