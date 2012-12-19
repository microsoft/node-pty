# pty.js

`forkpty(3)` bindings for node.js. This allows you to fork processes with pseudo
terminal file descriptors. It returns a terminal object which allows reads
and writes.

This is useful for:

- Writing a terminal emulator.
- Getting certain programs to *think* you're a terminal. This is useful if
  you need a program to send you control sequences.

## Example Usage

``` js
var pty = require('pty.js');

var term = pty.fork('sh', [], {
  name: 'xterm',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

term.ready(function() {

    term.on('data', function(data) {
	  console.log(data);
	});

	term.write('ls\r');
	term.resize(100, 40);
	term.write('ls /\r');

	console.log(term.process);
});

```

## Windows Support

On Windows pty.js works by starting the winpty-agent.exe process with a new, 
hidden console window, which bridges between the console API and terminal input/output escape codes. 
It polls the hidden console's screen buffer for changes and generates a corresponding stream of output.

Please note that the only way to achieve pty support on windows is by scraping a terminal
window every 25 milliseconds. This is the same approach as [console2](http://sourceforge.net/projects/console/) uses.

## Todo

- Add tcsetattr(3), tcgetattr(3).
- Add a way of determining the current foreground job for platforms other
  than Linux and OSX/Darwin.

## License

Copyright (c) 2012, Christopher Jeffrey (MIT License).
