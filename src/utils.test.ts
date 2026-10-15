/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as assert from 'assert';
import { assign } from './utils';

describe('utils', () => {
  describe('assign', () => {
    it('should copy an own __proto__ key as an own property', () => {
      const source = JSON.parse('{"__proto__":"selected-value","NORMAL":"control"}');
      const target = assign({}, source);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(target, '__proto__'), true);
      assert.strictEqual(Object.getOwnPropertyDescriptor(target, '__proto__')!.value, 'selected-value');
      assert.strictEqual(Object.getPrototypeOf(target), Object.prototype);
      assert.strictEqual(target.NORMAL, 'control');
    });
  });
});
