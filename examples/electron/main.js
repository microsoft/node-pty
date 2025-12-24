const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

let mainWindow;
let ptyProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    mainWindow = null;
  });
}

// Handle pty spawn request from renderer
ipcMain.on('pty-spawn', () => {
  if (ptyProcess) return;

  const shell = process.env[os.platform() === 'win32' ? 'COMSPEC' : 'SHELL'];
  ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME || process.env.USERPROFILE,
    env: process.env
  });

  ptyProcess.onData(data => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty-data', data);
    }
  });
});

// Handle pty input from renderer
ipcMain.on('pty-write', (_, data) => {
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

// Handle resize from renderer
ipcMain.on('pty-resize', (_, { cols, rows }) => {
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
