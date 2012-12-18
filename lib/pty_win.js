/**
 * pty_win.js
 * Copyright (c) 2012, Christopher Jeffrey, Peter Sunde (MIT License)
 */
var net = require('net'),
    BaseTerminal = require('./pty.js').Terminal,
    pty = require('../build/Release/pty.node'),
    assert = require('assert'),
    util = require('util'),
    pipeIncr = 0;

/**
 * Agent
 * 
 * Everytime a new pseudo terminal is created it is contained
 * within agent.exe. When this process is started there are two
 * available named pipes (control and data socket).
 * 
 */
function Agent(file, args, env, cwd, cols, rows) {
    var self = this;
    
    // Advance the number of pipes created
    pipeIncr++;

    // The control pipe allows us to communicate with each agent.exe
    // process and exchange various commands.
    this.controlPipe = '\\\\.\\pipe\\winpty-control-' + pipeIncr;

    // The datapipe is a raw communication channel with the forked
    // pty pseudo terminal.
    this.dataPipe = '\\\\.\\pipe\\winpty-data-' + pipeIncr;
  
    // Not available yet
    this.pid = -1;
    this.fd = -1;
    this.pty = -1;

    // Dummy socket for awaiting `ready` event
    this.ptySocket = new net.Socket();

    // Create terminal pipe IPC channel and forward
    // to a local unix socket.
    this.ptyDataPipe = net.createServer(function (socket) {

        // Todo: Is this always correct?
        socket.setEncoding('utf8');
       
        // Pause socket so that we do not loose any data events
        socket.pause();
       
        // Start terminal
        var info = pty.startProcess(self.pid, "file", [], [], "cwd");
        
        // Emit ready event
        self.ptySocket.emit('ready', socket);
        
    }).listen(this.dataPipe, function() {
        
        // Open terminal when socket has been created
        var term = pty.open(self.controlPipe, self.dataPipe, cols, rows);
        
        // Assign process information
        self.pid = term.pid;
        self.fd = term.fd;
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
    debug = opt.debug || false;
    
    // Add debug variable if enabled that tells agent.exe
    // to connect to the debug pipe. Please start a new instance of 
    // deps/winpty/DebugServer.py before starting this node addon.
    if(debug) {
        env.WINPTYDBG = true;
    }
    
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
        console.log("ready")
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