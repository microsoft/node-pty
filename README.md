# node-pty

**⚠️ This project is currently under development to improve Windows support, see [this issue](https://github.com/Microsoft/vscode/issues/13625) for more details.**

`forkpty(3)` bindings for node.js. This allows you to fork processes with pseudo
terminal file descriptors. It returns a terminal object which allows reads
and writes.

This is useful for:

- Writing a terminal emulator.
- Getting certain programs to *think* you're a terminal. This is useful if
  you need a program to send you control sequences.

## Example Usage

``` js
var pty = require('node-pty');

var term = pty.spawn('bash', [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

term.on('data', function(data) {
  console.log(data);
});

term.write('ls\r');
term.resize(100, 40);
term.write('ls /\r');

console.log(term.process);
```

## License

Copyright (c) 2012-2015, Christopher Jeffrey (MIT License).
Copyright (c) 2016, Daniel Imms (MIT License).
