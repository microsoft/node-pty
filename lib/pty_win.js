/**
 * pty_win.js
 * Copyright (c) 2012, Christopher Jeffrey, Peter Sunde (MIT License)
 */
var net = require('net'),
    BaseTerminal = require('./pty.js').Terminal,
    pty = require('../build/Release/pty.node'),
    util = require('util'),
    pipeIncr = 0;

/**
 * PipeWriter
 */
function PipeWriter(socket) {
    this.socket = socket;
    this.encoding = 'utf16le';
    this.packets = [];
}

PipeWriter.prototype.putInt = function (value, prepend) {
    var buffer = new Buffer(4);
    buffer.writeInt32LE(value, 0);
    this.packets[prepend ? 'unshift' : 'push'](buffer);
    return this;
}

PipeWriter.prototype.putString = function (value) {
    value = new Buffer(value, this.encoding);
    this.putInt(value.length);
    this.packets.push(value);
    return this;
}

PipeWriter.prototype.flush = function () {
    var buffer,
    targetStart = 0,
        packetsMerged = 0;

    // Size of transport	
    this.putInt(this.getTransportSize(), true);

    // Allocate a new buffer
    buffer = new Buffer(this.getTransportSize());

    // Merge all packets
    this.packets.forEach(function (packet) {
        packet.copy(buffer, targetStart, 0, packet.length);
        targetStart += packet.length;
        packetsMerged++;
    });

    // Write transport
    this.socket.write(buffer);

    // Reset transport
    this.packets = [];

}

PipeWriter.prototype.getTransportSize = function () {
    var size = 0;
    this.packets.forEach(function (packet) {
        size += packet.length;
    });
    return size;
}

/**
 * Agent
 */
function Agent(file, args, env, cwd, cols, rows) {
    var self = this,
        isControlPipeAvailable = false,
        isDataPipeAvailable = false,
        pipesCreated = 0;

    // Advance the number of pipes created
    pipeIncr++;

    // The control pipe allows us to communicate with each agent.exe
    // process and exchange various commands.
    this.controlPipe = '\\\\.\\pipe\\winpty-control-' + pipeIncr;

    // The datapipe is a raw communication channel with the forked
    // pty pseudo terminal.
    this.dataPipe = '\\\\.\\pipe\\winpty-data-' + pipeIncr;

    this.pid = 0;
    this.fd = -1;
    this.pty = -1;

    // Dummy socket for awaiting `ready` event
    this.ptySocket = new net.Socket();

    function hasPipes() {
        // Wait until both pipes are created
        if (++pipesCreated !== 2) return;
        var term = pty.open(self.controlPipe, self.dataPipe, cols, rows);
        self.pid = term.pid;
        self.fd = term.fd;
        self.pty = term.pty;
    }

    // Create control pipe IPC channel
    self.ptyControlServer = net.createServer(function (socket) {
        // Only create once
        if (!isControlPipeAvailable) {
            self.pipeWriter = new PipeWriter(socket);
            isControlPipeAvailable = true;
        }
        self.pipeWriter.putInt(Agent.Command.StartProcess)
            .flush();
    }).listen(this.controlPipe, hasPipes);

    // Create terminal pipe IPC channel and forward
    // to a local unix socket.
    self.ptyServer = net.createServer(function (socket) {
        socket.setEncoding('utf8');
        socket.pause();
        // Only create once
        if (!isDataPipeAvailable) {
            // Wait until control pipe is ready
            every(50, function () {
                if (isControlPipeAvailable) {
                    self.ptySocket.emit('ready', socket);
                    return false;
                }
            });
            isDataPipeAvailable = true;
        }
    }).listen(this.dataPipe, hasPipes);

}

// Please see AgentMsg.h
Agent.Command = {
    Ping: 0,
    StartProcess: 1,
    SetSize: 2,
    GetProcessId: 4,
    Kill: 5
}

/**
 * Resize a terminal window
 */
Agent.prototype.resize = function (rows, cols) {
    this.pipeWriter.putInt(Agent.Command.SetSize)
        .putInt(rows)
        .putInt(cols)
        .flush();
}

/**
 * Kill agent.exe and forked terminal.
 */
Agent.prototype.kill = function () {
    this.pipeWriter.putInt(Agent.Command.Kill)
        .flush();
}

/**
 * Terminal
 */

// Example:
//  var term = new Terminal('cmd.exe', [], {
//    name: 'Windows Shell',
//    cols: 80,
//    rows: 30,
//    cwd: process.env.HOME,
//    env: process.env
//  });
//
// term.ready(function() {
// 		term.on('data', function() {
//
//		});
// });
//

function Terminal(file, args, opt) {

    var self = this,
        env, cwd, name, cols, rows, term, agent;

    // backward compatibility
    if (typeof args === 'string') {
        opt = {
            name: arguments[1],
            cols: arguments[2],
            rows: arguments[3],
            cwd: process.env.HOME
        };
        args = [];
    }

    // arguments
    args = args || [];
    file = file || 'cmd.exe';
    opt = opt || {};

    cols = opt.cols || 80;
    rows = opt.rows || 30;
    env = clone(opt.env || process.env);
    cwd = opt.cwd || process.cwd();
    name = opt.name || env.TERM || 'Windows Shell';

    env.TERM = name;
    env = environ(env);

    // callback for when ready
    this.onReadyCallback = function () {};

    // create new pty
    this.agent = new Agent(file, args, env, cwd, cols, rows);

    // Setup our data pipe
    this.socket = this.agent.ptySocket;

    // Not available until `ready` event is recieved.
    this.pid = -1;

    // Never available on windows
    this.fd = -1;

    // Not available on windows but will have an incremental value
    this.pty = -1;

    // Replace with real terminal pipe socket
    this.socket.on('ready', function (socket) {

        // Remove `ready` socket
        self.socket.destroy();

        // Grab new socket
        self.socket = socket;

        // Grab information about terminal
        self.pid = self.agent.pid;
        self.fd = self.agent.fd;
        self.pty = self.agent.pty;

        // Trigger ready callback
        self.onReadyCallback();

        // Resume socket
        self.socket.resume();

        // Setup
        self.socket.on('error', function (err) {

            // close
            self._close();

            // EIO, happens when someone closes our child
            // process: the only process in the terminal.
            // node < 0.6.14: errno 5
            // node >= 0.6.14: read EIO
            if (err.code) {
                if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) return;
            }

            // throw anything else
            if (self.listeners('error').length < 2) {
                throw err;
            }

        });

        self.socket.on('close', function () {
            Terminal.total--;
            self._close();
            self.emit('exit', null);
        });

    });

    this.file = file;
    this.name = name;
    this.cols = cols;
    this.rows = rows;

    this.readable = true;
    this.writable = true;

    Terminal.total++;

}

Terminal.fork = Terminal.spawn = Terminal.createTerminal = function (file, args, opt) {
    return new Terminal(file, args, opt);
};

// Inherit from pty.js
util.inherits(Terminal, BaseTerminal);

/**
 * Total
 */

// Keep track of the total
// number of terminals for
// the process.
Terminal.total = 0;

/**
 * Events
 */

Terminal.prototype.ready = function (callback) {
    this.onReadyCallback = callback;
}

/**
 * openpty
 */

Terminal.open = function () {
    throw new Error("open() not supported on windows, use Fork() instead.");
};

/**
 * TTY
 */

Terminal.prototype.resize = function (cols, rows) {
    cols = cols || 80;
    rows = rows || 24;

    this.cols = cols;
    this.rows = rows;

    this.agent.resize(cols, rows);

};

Terminal.prototype.destroy = function () {
    this.kill();
};

Terminal.prototype.kill = function (sig) {
    if (sig !== undefined) {
        throw new Error("Signals not supported on windows.");
    }
    this._close();
    this.agent.kill();
};

Terminal.prototype.__defineGetter__('process', function () {
    return this.name;
});

/**
 * Helpers
 */

function every(ms, callback) {
    setTimeout(function () {
        if (false !== callback()) {
            every(ms, callback);
        }
    }, ms);
}

function clone(a) {
    var keys = Object.keys(a || {}),
        l = keys.length,
        i = 0,
        b = {};

    for (; i < l; i++) {
        b[keys[i]] = a[keys[i]];
    }

    return b;
}

function environ(env) {
    var keys = Object.keys(env || {}),
        l = keys.length,
        i = 0,
        pairs = [];

    for (; i < l; i++) {
        pairs.push(keys[i] + '=' + env[keys[i]]);
    }

    return pairs;
}

/**
 * Expose
 */
exports = Terminal;
exports.Terminal = Terminal;
exports.native = undefined;
module.exports = exports;
