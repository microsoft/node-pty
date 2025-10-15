/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

export function assign(target: any, ...sources: any[]): any {
  sources.forEach(source => Object.keys(source).forEach(key => target[key] = source[key]));
  return target;
}


export function loadNativeModule(name: string): {dir: string, module: any} {
  // Check prebuild, build, and then debug build.
  const dirs = [`prebuilds/${process.platform}-${process.arch}`, 'build/Release', 'build/Debug'];
  // Check relative to the current dir for bundled and to the parent dir for unbundled.
  const relative = ['.', '..'];
  let lastError: unknown;
  for (const d of dirs) {
    for (const r of relative) {
      const dir = `${r}/${d}/`;
      try {
        return { dir, module: require(`${dir}/${name}.node`) };
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw new Error(`Failed to load native module: ${name}.node, checked: ${dirs.join(', ')}: ${lastError}`);
}
