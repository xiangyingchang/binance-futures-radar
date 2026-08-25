(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BtcV3TrackingKeyStorage = factory();
}(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';

  const STORAGE_KEY = 'btc-v3-tracking-api-key-local';
  const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

  function getStorage(scope) {
    try {
      const storage = scope.localStorage;
      const probe = STORAGE_KEY + ':probe';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    } catch (_) {
      return null;
    }
  }

  function parseEntry(raw, now) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const key = typeof parsed.key === 'string' ? parsed.key.trim() : '';
      const lastUsedAt = Number(parsed.lastUsedAt);
      if (!key || !Number.isFinite(lastUsedAt)) return null;
      if (now - lastUsedAt >= IDLE_TIMEOUT_MS) return null;
      if (lastUsedAt - now > 5 * 60 * 1000) return null;
      return { key, lastUsedAt };
    } catch (_) {
      return null;
    }
  }

  return {
    STORAGE_KEY,
    IDLE_TIMEOUT_MS,
    get(scope, now = Date.now()) {
      const storage = getStorage(scope);
      if (!storage) return '';
      const entry = parseEntry(storage.getItem(STORAGE_KEY), now);
      if (!entry) {
        try { storage.removeItem(STORAGE_KEY); } catch (_) {}
        return '';
      }
      return entry.key;
    },
    put(scope, key, now = Date.now()) {
      const value = String(key || '').trim();
      if (!value) return false;
      const storage = getStorage(scope);
      if (!storage) return false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ key: value, lastUsedAt: now }));
        return true;
      } catch (_) {
        return false;
      }
    },
    touch(scope, now = Date.now()) {
      const storage = getStorage(scope);
      if (!storage) return;
      const entry = parseEntry(storage.getItem(STORAGE_KEY), now);
      if (!entry) {
        try { storage.removeItem(STORAGE_KEY); } catch (_) {}
        return;
      }
      try { storage.setItem(STORAGE_KEY, JSON.stringify({ key: entry.key, lastUsedAt: now })); } catch (_) {}
    },
    remove(scope) {
      const storage = getStorage(scope);
      if (!storage) return;
      try { storage.removeItem(STORAGE_KEY); } catch (_) {}
    },
  };
}));
