import { describe, expect, it } from 'vitest';
import {
  decryptSecret, encryptSecret, generateApiKey, hashPassword, keyHint, sha256, verifyPassword,
} from './crypto.js';

describe('secret handling', () => {
  it('round-trips an AES-256-GCM envelope without exposing plaintext', () => {
    const plaintext = 'ce_live_super-secret';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('hashes passwords with a random salt and verifies them safely', async () => {
    const first = await hashPassword('Correct horse battery staple!');
    const second = await hashPassword('Correct horse battery staple!');
    expect(first).not.toBe(second);
    await expect(verifyPassword('Correct horse battery staple!', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
  });

  it('generates prefixed downstream keys and non-secret hints', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^pk_live_[A-Za-z0-9_-]+$/);
    expect(keyHint(key)).toMatch(/^pk_live_.*…....$/);
    expect(sha256(key)).toHaveLength(64);
  });
});
