// Initialize xterm.js and attach it to the DOM
const xterm = new window.Terminal();
xterm.open(document.getElementById('xterm'));

// Setup communication between xterm.js and node-pty via IPC
xterm.onData(data => window.pty.write(data));
window.pty.onData(data => xterm.write(data));

// Initiate pty spawn as renderer is ready
window.pty.spawn();
