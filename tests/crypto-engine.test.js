import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const MAGIC_V4 = new Uint8Array([0x47,0x5A,0x4E,0x44,0x5F,0x45,0x4E,0x43,0x5F,0x56,0x34]);
const MAGIC_V2 = new Uint8Array([0x47,0x5A,0x4E,0x44,0x5F,0x45,0x4E,0x43,0x5F,0x56,0x32]);
const SALT_LEN = 32;
const IV_LEN = 12;
const UID_HASH_LEN = 32;
const PBKDF2_ITERS_V4 = 210000;
const PBKDF2_ITERS_V2 = 100000;

async function deriveKeyV4(email, password, uid, salt) {
  const enc = new TextEncoder();
  const ikm = enc.encode(email.toLowerCase().trim() + ':' + password + ':' + (uid || ''));
  const keyMaterial = await crypto.subtle.importKey('raw', ikm, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS_V4, hash: 'SHA-512' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function deriveKeyV2(email, password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(email.toLowerCase().trim() + ':' + password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS_V2, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function _hashUID(uid) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid || ''));
  return new Uint8Array(buf);
}

const CryptoEngine = {
  async encrypt(dataObj, email, password, uid) {
    const _uid = uid || '';
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const uidHash = await _hashUID(_uid);
    const key = await deriveKeyV4(email, password, _uid, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(dataObj));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    const ctBytes = new Uint8Array(ciphertext);
    const out = new Uint8Array(MAGIC_V4.length + UID_HASH_LEN + SALT_LEN + IV_LEN + ctBytes.length);
    let offset = 0;
    out.set(MAGIC_V4, offset); offset += MAGIC_V4.length;
    out.set(uidHash, offset); offset += UID_HASH_LEN;
    out.set(salt, offset);    offset += SALT_LEN;
    out.set(iv, offset);      offset += IV_LEN;
    out.set(ctBytes, offset);
    return out.buffer;
  },

  async decrypt(arrayBuffer, email, password, uid) {
    const bytes = new Uint8Array(arrayBuffer);
    const magicLen = MAGIC_V4.length;
    const isV4 = bytes.length >= magicLen && MAGIC_V4.every((b, i) => bytes[i] === b);
    const isV2 = !isV4 && bytes.length >= magicLen && MAGIC_V2.every((b, i) => bytes[i] === b);
    if (!isV4 && !isV2) throw new Error('INVALID_FORMAT');
    let offset = magicLen;
    if (isV4) {
      const storedUidHash = bytes.slice(offset, offset + UID_HASH_LEN); offset += UID_HASH_LEN;
      const _uid = uid || '';
      const actualUidHash = await _hashUID(_uid);
      const uidMatch = storedUidHash.every((b, i) => b === actualUidHash[i]);
      if (!uidMatch) throw new Error('WRONG_ACCOUNT');
      const salt = bytes.slice(offset, offset + SALT_LEN); offset += SALT_LEN;
      const iv   = bytes.slice(offset, offset + IV_LEN);   offset += IV_LEN;
      const ciphertext = bytes.slice(offset);
      const key = await deriveKeyV4(email, password, _uid, salt);
      try {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder().decode(plaintext));
      } catch(e) { throw new Error('WRONG_CREDENTIALS'); }
    } else {
      const salt = bytes.slice(offset, offset + SALT_LEN); offset += SALT_LEN;
      const iv   = bytes.slice(offset, offset + IV_LEN);   offset += IV_LEN;
      const ciphertext = bytes.slice(offset);
      const key = await deriveKeyV2(email, password, salt);
      try {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder().decode(plaintext));
      } catch(e) { throw new Error('WRONG_CREDENTIALS'); }
    }
  }
};

async function buildV2Blob(dataObj, email, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key  = await deriveKeyV2(email, password, salt);
  const plaintext  = new TextEncoder().encode(JSON.stringify(dataObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const ctBytes    = new Uint8Array(ciphertext);
  const out = new Uint8Array(MAGIC_V2.length + SALT_LEN + IV_LEN + ctBytes.length);
  let offset = 0;
  out.set(MAGIC_V2, offset); offset += MAGIC_V2.length;
  out.set(salt,     offset); offset += SALT_LEN;
  out.set(iv,       offset); offset += IV_LEN;
  out.set(ctBytes,  offset);
  return out.buffer;
}

const EMAIL    = 'dealer@example.com';
const PASSWORD = 'correct-horse-battery-staple';
const UID      = 'uid-abc-123';
const PAYLOAD  = { sales: [{ id: 'rec-1', amount: 5000 }], version: 4 };

describe('CryptoEngine', () => {

  describe('V4 round-trip', () => {
    it('decrypts to the original object', async () => {
      const buf    = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      const result = await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, UID);
      assert.deepEqual(result, PAYLOAD);
    });

    it('produces different ciphertext on every call (random salt+iv)', async () => {
      const buf1 = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      const buf2 = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      assert.notDeepEqual(new Uint8Array(buf1), new Uint8Array(buf2));
    });

    it('round-trips empty object', async () => {
      const buf    = await CryptoEngine.encrypt({}, EMAIL, PASSWORD, UID);
      const result = await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, UID);
      assert.deepEqual(result, {});
    });

    it('round-trips deeply nested payload', async () => {
      const deep = { a: { b: { c: { d: [1, 2, 3], e: 'nested' } } }, ts: 1700000000000 };
      const buf  = await CryptoEngine.encrypt(deep, EMAIL, PASSWORD, UID);
      assert.deepEqual(await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, UID), deep);
    });

    it('treats email as case-insensitive', async () => {
      const buf    = await CryptoEngine.encrypt(PAYLOAD, 'DEALER@EXAMPLE.COM', PASSWORD, UID);
      const result = await CryptoEngine.decrypt(buf, 'dealer@example.com', PASSWORD, UID);
      assert.deepEqual(result, PAYLOAD);
    });

    it('strips leading/trailing whitespace from email', async () => {
      const buf    = await CryptoEngine.encrypt(PAYLOAD, '  dealer@example.com  ', PASSWORD, UID);
      const result = await CryptoEngine.decrypt(buf, 'dealer@example.com', PASSWORD, UID);
      assert.deepEqual(result, PAYLOAD);
    });

    it('output starts with V4 magic bytes', async () => {
      const buf   = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      const bytes = new Uint8Array(buf);
      const magic = bytes.slice(0, MAGIC_V4.length);
      assert.deepEqual(magic, MAGIC_V4);
    });

    it('output length is magic + uidHash + salt + iv + ciphertext', async () => {
      const buf  = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      const ct   = new TextEncoder().encode(JSON.stringify(PAYLOAD)).length + 16;
      const expected = MAGIC_V4.length + UID_HASH_LEN + SALT_LEN + IV_LEN + ct;
      assert.equal(new Uint8Array(buf).length, expected);
    });
  });

  describe('V4 error cases', () => {
    it('throws WRONG_CREDENTIALS on wrong password', async () => {
      const buf = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      await assert.rejects(
        () => CryptoEngine.decrypt(buf, EMAIL, 'wrong-password', UID),
        (e) => { assert.equal(e.message, 'WRONG_CREDENTIALS'); return true; }
      );
    });

    it('throws WRONG_ACCOUNT when UID does not match', async () => {
      const buf = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      await assert.rejects(
        () => CryptoEngine.decrypt(buf, EMAIL, PASSWORD, 'different-uid'),
        (e) => { assert.equal(e.message, 'WRONG_ACCOUNT'); return true; }
      );
    });

    it('throws INVALID_FORMAT on arbitrary bytes', async () => {
      const junk = new Uint8Array(128).fill(0xff).buffer;
      await assert.rejects(
        () => CryptoEngine.decrypt(junk, EMAIL, PASSWORD, UID),
        (e) => { assert.equal(e.message, 'INVALID_FORMAT'); return true; }
      );
    });

    it('throws INVALID_FORMAT on empty buffer', async () => {
      await assert.rejects(
        () => CryptoEngine.decrypt(new ArrayBuffer(0), EMAIL, PASSWORD, UID),
        (e) => { assert.equal(e.message, 'INVALID_FORMAT'); return true; }
      );
    });

    it('throws WRONG_CREDENTIALS on truncated ciphertext', async () => {
      const buf   = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      const bytes = new Uint8Array(buf);
      const truncated = bytes.slice(0, bytes.length - 10).buffer;
      await assert.rejects(
        () => CryptoEngine.decrypt(truncated, EMAIL, PASSWORD, UID),
        (e) => {
          assert.ok(
            e.message === 'WRONG_CREDENTIALS' || e.message === 'WRONG_ACCOUNT',
            `unexpected error: ${e.message}`
          );
          return true;
        }
      );
    });

    it('throws WRONG_CREDENTIALS on single flipped bit in ciphertext', async () => {
      const buf   = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, UID);
      const bytes = new Uint8Array(buf.slice(0));
      bytes[bytes.length - 5] ^= 0x01;
      await assert.rejects(
        () => CryptoEngine.decrypt(bytes.buffer, EMAIL, PASSWORD, UID),
        (e) => { assert.equal(e.message, 'WRONG_CREDENTIALS'); return true; }
      );
    });
  });

  describe('V2 legacy decrypt', () => {
    it('decrypts V2 blob successfully', async () => {
      const buf    = await buildV2Blob(PAYLOAD, EMAIL, PASSWORD);
      const result = await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, UID);
      assert.deepEqual(result, PAYLOAD);
    });

    it('V2 does not enforce UID binding', async () => {
      const buf    = await buildV2Blob(PAYLOAD, EMAIL, PASSWORD);
      const result = await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, 'completely-different-uid');
      assert.deepEqual(result, PAYLOAD);
    });

    it('throws WRONG_CREDENTIALS on wrong password for V2', async () => {
      const buf = await buildV2Blob(PAYLOAD, EMAIL, PASSWORD);
      await assert.rejects(
        () => CryptoEngine.decrypt(buf, EMAIL, 'wrong', UID),
        (e) => { assert.equal(e.message, 'WRONG_CREDENTIALS'); return true; }
      );
    });
  });

  describe('UID fallback', () => {
    it('encrypts and decrypts with empty-string UID', async () => {
      const buf    = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, '');
      const result = await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, '');
      assert.deepEqual(result, PAYLOAD);
    });

    it('uid=null treated same as empty string', async () => {
      const buf    = await CryptoEngine.encrypt(PAYLOAD, EMAIL, PASSWORD, null);
      const result = await CryptoEngine.decrypt(buf, EMAIL, PASSWORD, null);
      assert.deepEqual(result, PAYLOAD);
    });
  });
});
