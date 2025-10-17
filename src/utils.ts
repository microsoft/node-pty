/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

export function assign(target: any, ...sources: any[]): any {
  sources.forEach(source => Object.keys(source).forEach(key => target[key] = source[key]));
  return target;
}


export function loadNativeModule(name: string): {dir: string, module: any} {
  // Check build, debug, and then prebuilds.
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  // Check relative to the parent dir for unbundled and then the current dir for bundled
  const relative = ['..', '.'];
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
