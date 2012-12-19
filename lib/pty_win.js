/**
 * pty_win.js
 * Copyright (c) 2012, Christopher Jeffrey, Peter Sunde (MIT License)
 */
var net = require('net'),
    BaseTerminal = require('./pty.js').Terminal,
    pty = require('../build/Release/pty.node'),
    assert = require('assert'),
    util = require('util'),
    path = require('path'),
    pipeIncr = 0;

/**
 * Agent
 * 
 * Everytime a new pseudo terminal is created it is contained
 * within agent.exe. When this process is started there are two
 * available named pipes (control and data socket).
 * 
 */
function Agent(file, args, env, cwd, cols, rows, debug) {
    var self = this;
    
    // Increment the number of pipes created.
    pipeIncr++;

    // The native addon uses this to communicate with the spawned
    // agent.exe process.
    this.controlPipe = '\\\\.\\pipe\\winpty-control-' + pipeIncr;

    // The data pipe is the direct connection to the forked terminal.
    this.dataPipe = '\\\\.\\pipe\\winpty-data-' + pipeIncr;
  
    // Please see description on line 70
    this.pid = -1;
    this.fd = -1;
    this.pty = -1;

    // Dummy socket for awaiting `ready` event.
    this.ptySocket = new net.Socket();

    // Create terminal pipe IPC channel and forward
    // to a local unix socket.
    this.ptyDataPipe = net.createServer(function (socket) {

        // Default socket encoding.
        socket.setEncoding('utf8');
       
        // Pause until `ready` event is emitted.
        socket.pause();
        
        // Sanitize input variable.
        file = file + args.join(' ');
        env = env.join(' ');
        cwd = path.resolve(cwd);
        
        // Start terminal session.
        pty.startProcess(self.pid, file, env, cwd);
        
        // Emit ready event.
        self.ptySocket.emit('ready', socket);
        
    }).listen(this.dataPipe, function() {
        
        // Open terminal session.
        var term = pty.open(self.controlPipe, self.dataPipe, cols, rows, debug);
        
        // Terminal pid.
        self.pid = term.pid;
        
        // Not available on windows.
        self.fd = term.fd;
        
        // Generated incremental number that has no real purpose besides
        // using it as a terminal id.
        self.pty = term.pty; 
        
    });

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
        env, cwd, name, cols, rows, term, agent, debug;

    // Backward compatibility
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
    debug = opt.debug || false;

    env.TERM = name;
    env = environ(env);

    // Callback when terminal session is ready.
    this.onReadyCallback = function () {};
    
    // Create new termal.
    this.agent = new Agent(file, args, env, cwd, cols, rows, debug);
   
    // Setup our data pipe.
    this.socket = this.agent.ptySocket;

    // Not available until `ready` event emitted.
    this.pid = -1;
    this.fd = -1;
    this.pty = -1;

    // The forked windows terminal is not available
    // until `ready` event is emitted.
    this.socket.on('ready', function (socket) {

        // Remove `ready` socket.
        self.socket.destroy();

        // Set new socket.
        self.socket = socket;

        // Set terminal information.
        self.pid = self.agent.pid;
        self.fd = self.agent.fd;
        self.pty = self.agent.pty;

        // Trigger ready callback.
        self.onReadyCallback();

        // Resume socket.
        self.socket.resume();

        // Shutdown if `error` event is emitted.
        self.socket.on('error', function (err) {

            // Close terminal session.
            self._close();

            // EIO, happens when someone closes our child
            // process: the only process in the terminal.
            // node < 0.6.14: errno 5
            // node >= 0.6.14: read EIO
            if (err.code) {
                if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) return;
            }

            // Throw anything else.
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
    
    pty.resize(this.pid, cols, rows);

};

Terminal.prototype.destroy = function () {
    this.kill();
};

Terminal.prototype.kill = function (sig) {
    if (sig !== undefined) {
        throw new Error("Signals not supported on windows.");
    }
    this._close();
    pty.kill(this.pid);
};

Terminal.prototype.__defineGetter__('process', function () {
    return this.name;
});

/**
 * Helpers
 */
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