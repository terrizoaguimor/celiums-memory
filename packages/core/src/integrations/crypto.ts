/**
 * Symmetric encryption for integration access tokens at rest.
 *
 * Algorithm: AES-256-GCM with random 12-byte IV per encryption. Output is
 * `<iv>:<authTag>:<ciphertext>` all base64url, stored as TEXT in Postgres.
 *
 * Key source: INTEGRATIONS_ENCRYPTION_KEY env var, 32 bytes base64-encoded.
 * If missing, we fall back to a deterministic derivation from JWT_SECRET so
 * dev/staging keep working — but production MUST set the dedicated key
 * (see deploy notes; the deterministic fallback is logged on first use).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function loadKey(): Buffer {
  const env = process.env['INTEGRATIONS_ENCRYPTION_KEY'];
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        'INTEGRATIONS_ENCRYPTION_KEY must be 32 bytes base64-encoded (44 chars).',
      );
    }
    return buf;
  }
  const fallback = process.env['JWT_SECRET'] ?? 'celiums-dev-secret-change-me';
  const derived = createHash('sha256').update(`celiums-integrations:${fallback}`).digest();
  if (!loadKey._warned) {
    // eslint-disable-next-line no-console
    console.warn(
      '[integrations/crypto] INTEGRATIONS_ENCRYPTION_KEY not set — deriving from JWT_SECRET. Set the dedicated key in production.',
    );
    loadKey._warned = true;
  }
  return derived;
}
loadKey._warned = false as unknown as boolean;

const KEY: Buffer = loadKey();

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}:${b64url(tag)}:${b64url(enc)}`;
}

export function decryptToken(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted token (expected iv:tag:ct).');
  }
  const [ivStr, tagStr, ctStr] = parts as [string, string, string];
  const iv = b64urlDecode(ivStr);
  const tag = b64urlDecode(tagStr);
  const ct = b64urlDecode(ctStr);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
