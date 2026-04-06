/**
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as assert from 'assert';
import * as path from 'path';
import { loadNativeModule } from './utils';

const nativeName = process.platform === 'win32' ? 'conpty' : 'pty';

describe('utils', () => {
  describe('loadNativeModule', () => {
    afterEach(() => {
      delete process.env.NODE_PTY_PREBUILT_PATH;
    });

    it('should load from NODE_PTY_PREBUILT_PATH when set to a valid path', () => {
      const validPath = path.resolve(__dirname, '..', 'build', 'Release');
      process.env.NODE_PTY_PREBUILT_PATH = validPath;
      const result = loadNativeModule(nativeName);
      assert.strictEqual(result.dir, validPath);
      assert.ok(result.module);
    });

    it('should fall through to default paths when NODE_PTY_PREBUILT_PATH is invalid', () => {
      process.env.NODE_PTY_PREBUILT_PATH = '/nonexistent/path';
      const result = loadNativeModule(nativeName);
      assert.ok(result.dir !== '/nonexistent/path');
      assert.ok(result.module);
    });

    it('should load normally when NODE_PTY_PREBUILT_PATH is not set', () => {
      delete process.env.NODE_PTY_PREBUILT_PATH;
      const result = loadNativeModule(nativeName);
      assert.ok(result.dir);
      assert.ok(result.module);
    });

    it('should include NODE_PTY_PREBUILT_PATH in error message when all paths fail', () => {
      process.env.NODE_PTY_PREBUILT_PATH = '/nonexistent/path';
      assert.throws(
        () => loadNativeModule('does-not-exist'),
        (err: Error) => err.message.includes('/nonexistent/path')
      );
    });
  });
});
