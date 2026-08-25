'use strict';

const assert = require('assert');
const storage = require('../btc-v3-tracking-key-storage');

function memoryScope() {
  const values = new Map();
  return {
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => { values.set(key, String(value)); },
      removeItem: (key) => { values.delete(key); },
    },
  };
}

function main() {
  const key = 'v3-tracking-access-key-test-only';
  const now = 1900000000000;

  {
    const scope = memoryScope();
    assert.strictEqual(storage.get(scope, now), '');
    assert.strictEqual(storage.put(scope, key, now), true);
    assert.strictEqual(storage.get(scope, now), key);
    assert.ok(scope.localStorage.getItem(storage.STORAGE_KEY).includes('lastUsedAt'));
  }

  {
    const scope = memoryScope();
    storage.put(scope, key, now);
    assert.strictEqual(storage.get(scope, now + storage.IDLE_TIMEOUT_MS - 1), key);
    assert.strictEqual(storage.get(scope, now + storage.IDLE_TIMEOUT_MS), '');
    assert.strictEqual(scope.localStorage.getItem(storage.STORAGE_KEY), null);
  }

  {
    const scope = memoryScope();
    storage.put(scope, key, now);
    const touchedAt = now + storage.IDLE_TIMEOUT_MS - 1;
    storage.touch(scope, touchedAt);
    assert.strictEqual(storage.get(scope, touchedAt), key);
    assert.strictEqual(storage.get(scope, touchedAt + storage.IDLE_TIMEOUT_MS - 1), key);
    assert.strictEqual(storage.get(scope, touchedAt + storage.IDLE_TIMEOUT_MS), '');
  }

  {
    const scope = memoryScope();
    storage.put(scope, key, now);
    storage.remove(scope);
    assert.strictEqual(scope.localStorage.getItem(storage.STORAGE_KEY), null);
    assert.strictEqual(storage.get(scope, now), '');
  }

  {
    const scope = memoryScope();
    scope.localStorage.setItem(storage.STORAGE_KEY, 'not-json');
    assert.strictEqual(storage.get(scope, now), '');
    assert.strictEqual(scope.localStorage.getItem(storage.STORAGE_KEY), null);

    scope.localStorage.setItem(storage.STORAGE_KEY, JSON.stringify({ key: '', lastUsedAt: now }));
    assert.strictEqual(storage.get(scope, now), '');

    scope.localStorage.setItem(storage.STORAGE_KEY, JSON.stringify({ key, lastUsedAt: 'invalid' }));
    assert.strictEqual(storage.get(scope, now), '');

    scope.localStorage.setItem(storage.STORAGE_KEY, JSON.stringify({ key, lastUsedAt: now + 60 * 60 * 1000 }));
    assert.strictEqual(storage.get(scope, now), '');
  }

  {
    const blocked = {
      localStorage: {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
      },
    };
    assert.strictEqual(storage.put(blocked, key, now), false);
    assert.strictEqual(storage.get(blocked, now), '');
    storage.touch(blocked, now);
    storage.remove(blocked);
  }

  console.log('btc-v3-tracking-key-storage tests passed');
}

main();
