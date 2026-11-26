/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

export function assign(target: any, ...sources: any[]): any {
  // defineProperty, not assignment: assigning to an own `__proto__` key would run the prototype setter.
  sources.forEach(source => Object.keys(source).forEach(key => Object.defineProperty(target, key, {
    value: source[key],
    enumerable: true,
    writable: true,
    configurable: true
  })));
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
      const dir = `${r}/${d}`;
      try {
        return { dir, module: require(`${dir}/${name}.node`) };
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw new Error(`Failed to load native module: ${name}.node, checked: ${dirs.join(', ')}: ${lastError}`);
}
