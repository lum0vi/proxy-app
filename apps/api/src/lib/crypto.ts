import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(scryptCallback);
const encryptionKey = Buffer.from(config.KEY_ENCRYPTION_SECRET, 'hex');

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function upstreamKeyFingerprint(value: string): string {
  return createHmac('sha256', encryptionKey).update('upstream-key\0').update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltHex, expectedHex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !saltHex || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const derived = (await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(envelope: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = envelope.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Unsupported encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateApiKey(): string {
  return `${config.API_KEY_PREFIX}${randomToken(32)}`;
}

export function keyHint(value: string): string {
  return `${value.slice(0, Math.min(10, value.length))}…${value.slice(-4)}`;
}
