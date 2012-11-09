var pty = require('./build/Release/pty.node'),
	net = require('net');

var term = pty.fork('test123', [], [], "C:\\", 80, 30);
console.log("Forked new terminal", term);

net.socket(term.dataPipe, function() {
	console.log("connected to terminal data pipe");
});