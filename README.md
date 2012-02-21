# pty.js

`forkpty(3)` bindings for node.js. This allows you to fork processes with pseudo
terminal file descriptors. It returns a terminal object which allows reads
and writes.

This is useful for:

- Writing a terminal emulator.
- Getting certain programs to *think* you're a terminal. This way
  they're willing to send you escape codes.

## Example Usage

``` js
var Terminal = require('pty');

var term = new Terminal('bash', 'xterm-color', 80, 30);

term.on('data', function(data) {
  console.log(data);
});

term.write('ls\r');
term.resize(100, 40);
term.write('ls /\r');
```

## License

Copyright (c) 2012, Christopher Jeffrey (MIT License).
