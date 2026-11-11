/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as fs from 'fs';
import * as path from 'path';

// Match require's process-local caching after a compressed addon loads successfully.
const loadedNativeModules = new Map<string, {dir: string, module: any}>();

export function assign(target: any, ...sources: any[]): any {
  sources.forEach(source => Object.keys(source).forEach(key => target[key] = source[key]));
  return target;
}


export function loadNativeModule(name: string): {dir: string, module: any} {
  const loaded = loadedNativeModules.get(name);
  if (loaded) { return loaded; }
  // Check build, debug, and then prebuilds.
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  // Check relative to the parent dir for unbundled and then the current dir for bundled
  const relative = ['..', '.'];
  let lastError: unknown;
  for (const d of dirs) {
    for (const r of relative) {
      const dir = `${r}/${d}`;
      const absoluteDir = path.resolve(__dirname, dir);
      if (fs.existsSync(path.join(absoluteDir, 'native-manifest.json'))) {
        const { materializeNative }: typeof import('./compressedNative') = require('./compressedNative');
        const decodedDir = materializeNative(absoluteDir, `${process.platform}-${process.arch}`);
        const result = { dir: decodedDir, module: require(path.join(decodedDir, `${name}.node`)) };
        loadedNativeModules.set(name, result);
        return result;
      }
      try {
        return { dir, module: require(`${dir}/${name}.node`) };
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw new Error(`Failed to load native module: ${name}.node, checked: ${dirs.join(', ')}: ${lastError}`);
}
