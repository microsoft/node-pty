## Testing in a real terminal

The recommended way to test node-pty during development is via the electron example:

```sh
cd examples/electron
npm ci
npm start
```

Alternatively, clone the xterm.js repository and link's node-pty module to this directory.

1. Clone xterm.js in a separate folder:
    ```sh
    git clone https://github.com/xtermjs/xterm.js
    npm ci
    npm run setup
    ```
2. Link the node-pty repo:
    ```
    rm -rf node_modules/node-pty # in xterm.js folder
    ln -s <path_to_node-pty> <path to xtermjs>/node_modules/node-pty
    ```
3. Hit ctrl/cmd+shift+b in VS Code or run the build/demo scripts manually:
    ```sh
    npm run tsc-watch # build ts
    npm run esbuild-watch # bundle ts/js
    npm run esbuild-demo # build demo/server
    npm run start # run server
    ```
4. Open http://127.0.0.1:3000 and test
5. Kill and restart the `npm run start` command to apply any changes made in node-pty
