# node-pty

[![Build status](https://tyriar.visualstudio.com/_apis/public/build/definitions/2d361770-e039-4acc-b2b2-ef8396473589/1/badge)](https://tyriar.visualstudio.com/node-pty/_build/index?definitionId=1)

`forkpty(3)` bindings for node.js. This allows you to fork processes with pseudoterminal file descriptors. It returns a terminal object which allows reads and writes.

This is useful for:

- Writing a terminal emulator (eg. via [xterm.js](https://github.com/sourcelair/xterm.js)).
- Getting certain programs to *think* you're a terminal, such as when you need a program to send you control sequences.

`node-pty` supports Linux, macOS and Windows. Windows support is possible by utilizing the [winpty](https://github.com/rprichard/winpty) library.

## Real-world Uses

`node-pty` powers many different terminal emulators, including:

- [Microsoft Visual Studio Code](https://code.visualstudio.com)
- [Hyper](https://hyper.is/)
- [Upterm](https://github.com/railsware/upterm)
- [Script Runner](https://github.com/ioquatix/script-runner) for Atom.
- [Theia](https://github.com/theia-ide/theia)
- [FreeMAN](https://github.com/matthew-matvei/freeman) file manager
- [atom-xterm](https://atom.io/packages/atom-xterm) - Atom plugin for providing terminals inside your Atom workspace.

Do you use node-pty in your application as well? Please open a [Pull Request](https://github.com/Tyriar/node-pty/pulls) to include it here. We would love to have it in our list.

## Example Usage

```js
var os = require('os');
var pty = require('node-pty');

var shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

var ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

ptyProcess.on('data', function(data) {
  console.log(data);
});

ptyProcess.write('ls\r');
ptyProcess.resize(100, 40);
ptyProcess.write('ls\r');
```

## Building

```bash
# Install dependencies and build C++
npm install
# Compile TypeScript -> JavaScript
npm run tsc
```

### Dependencies on Windows

`npm install` requires some tools to be present in the system like Python and C++ compiler. Windows users can easily install them by running the following command in PowerShell as administrator. For more information see https://github.com/felixrieseberg/windows-build-tools:

```sh
npm install --global --production windows-build-tools
```

## Debugging

On Windows, you can show the winpty agent console window by adding the environment variable `WINPTY_SHOW_CONSOLE=1` to the pty's environment. See https://github.com/rprichard/winpty#debugging-winpty for more information.

## Troubleshooting

**Powershell gives error 8009001d**

> Internal Windows PowerShell error.  Loading managed Windows PowerShell failed with error 8009001d.

This happens when PowerShell is launched with no `SystemRoot` environment variable present.

## pty.js

This project is forked from [chjj/pty.js](https://github.com/chjj/pty.js) with the primary goals being to provide better support for later Node.JS versions and Windows.

## License

Copyright (c) 2012-2015, Christopher Jeffrey (MIT License).
Copyright (c) 2016, Daniel Imms (MIT License).
