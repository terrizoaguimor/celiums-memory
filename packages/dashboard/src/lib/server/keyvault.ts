/**
 * BYOK encrypted key vault.
 *
 * Stores user-provided API keys (OpenAI, Anthropic, DigitalOcean Inference,
 * etc.) encrypted at rest with AES-256-GCM. The master encryption key is
 * generated once on first boot and persisted at /etc/celiums/master.key
 * with mode 0600. Plaintext values are NEVER returned by the API — the
 * dashboard only ever shows the last 4 characters.
 *
 * The vault file is a JSON object encrypted as a single AES-GCM blob:
 *
 *   nonce(12) || ciphertext || authTag(16)
 *
 * stored base64-encoded at /etc/celiums/keyvault.enc.
 *
 * Single-tenant droplet model. For multi-tenant, swap the file backend
 * for a Postgres row keyed by tenant id.
 */

import { promises as fs } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { dirname } from 'node:path';

const DEFAULT_VAULT_PATH = process.env.CELIUMS_VAULT_PATH ?? '/etc/celiums/keyvault.enc';
const DEFAULT_MASTER_PATH = process.env.CELIUMS_MASTER_KEY_PATH ?? '/etc/celiums/master.key';
const ENV_MASTER_OVERRIDE = process.env.CELIUMS_MASTER_KEY; // base64 32 bytes; takes precedence over file

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface VaultEntry {
  /** Provider id, e.g. 'do-inference', 'openai', 'anthropic', 'custom'. */
  provider: string;
  /** Optional human label so the user can keep multiple keys per provider. */
  label?: string;
  /** Plaintext API key — only ever held in memory at write time. */
  value: string;
  /** Optional override for non-default base URL (e.g. self-hosted vLLM). */
  baseUrl?: string;
  /** Optional override for default model id. */
  model?: string;
  /** ISO timestamp of last write. */
  updatedAt: string;
}

export interface RedactedVaultEntry {
  provider: string;
  label?: string;
  /** Last 4 characters only, prefixed with bullet runs. */
  preview: string;
  baseUrl?: string;
  model?: string;
  updatedAt: string;
}

/** Load (or generate + persist) the master key. */
async function getMasterKey(): Promise<Buffer> {
  if (ENV_MASTER_OVERRIDE) {
    const buf = Buffer.from(ENV_MASTER_OVERRIDE, 'base64');
    if (buf.length !== KEY_LEN) {
      throw new Error(`CELIUMS_MASTER_KEY must be ${KEY_LEN} bytes base64-encoded`);
    }
    return buf;
  }
  try {
    const raw = await fs.readFile(DEFAULT_MASTER_PATH);
    if (raw.length === KEY_LEN) return raw;
    // Treat as base64 if read returns non-32 bytes
    const b = Buffer.from(raw.toString('utf8').trim(), 'base64');
    if (b.length === KEY_LEN) return b;
    throw new Error('Master key file present but malformed');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // First boot — generate a fresh master key
    const fresh = randomBytes(KEY_LEN);
    await fs.mkdir(dirname(DEFAULT_MASTER_PATH), { recursive: true });
    await fs.writeFile(DEFAULT_MASTER_PATH, fresh, { mode: 0o600 });
    return fresh;
  }
}

/** Wrap derive in case we ever change to passphrase-based. */
export async function deriveMasterFromPassphrase(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scryptSync(passphrase, salt, KEY_LEN);
}

function encryptBlob(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, enc, tag]);
}

function decryptBlob(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error('vault blob too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

async function readVault(): Promise<Record<string, VaultEntry>> {
  let raw: string;
  try {
    raw = await fs.readFile(DEFAULT_VAULT_PATH, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const blob = Buffer.from(raw.trim(), 'base64');
  const master = await getMasterKey();
  const plaintext = decryptBlob(blob, master).toString('utf8');
  return JSON.parse(plaintext) as Record<string, VaultEntry>;
}

async function writeVault(entries: Record<string, VaultEntry>): Promise<void> {
  const master = await getMasterKey();
  const plaintext = Buffer.from(JSON.stringify(entries));
  const blob = encryptBlob(plaintext, master);
  await fs.mkdir(dirname(DEFAULT_VAULT_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_VAULT_PATH, blob.toString('base64'), { mode: 0o600 });
}

function redact(entry: VaultEntry): RedactedVaultEntry {
  const v = entry.value;
  const last4 = v.length >= 4 ? v.slice(-4) : v;
  const preview = `••••••••${last4}`;
  const r: RedactedVaultEntry = {
    provider: entry.provider,
    preview,
    updatedAt: entry.updatedAt,
  };
  if (entry.label !== undefined) r.label = entry.label;
  if (entry.baseUrl !== undefined) r.baseUrl = entry.baseUrl;
  if (entry.model !== undefined) r.model = entry.model;
  return r;
}

function entryKey(provider: string, label?: string): string {
  return label ? `${provider}::${label}` : provider;
}

// ───────────────────────── Public API ─────────────────────────

/** List all stored entries with values redacted. Safe to return to the client. */
export async function listKeys(): Promise<RedactedVaultEntry[]> {
  const all = await readVault();
  return Object.values(all)
    .map(redact)
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Save (insert or replace) an entry. */
export async function setKey(input: Omit<VaultEntry, 'updatedAt'>): Promise<RedactedVaultEntry> {
  if (!input.value || input.value.length < 4) {
    throw new Error('API key value too short to be valid');
  }
  const all = await readVault();
  const key = entryKey(input.provider, input.label);
  const entry: VaultEntry = { ...input, updatedAt: new Date().toISOString() };
  all[key] = entry;
  await writeVault(all);
  return redact(entry);
}

/** Delete an entry. Returns true if it existed. */
export async function deleteKey(provider: string, label?: string): Promise<boolean> {
  const all = await readVault();
  const key = entryKey(provider, label);
  if (!(key in all)) return false;
  delete all[key];
  await writeVault(all);
  return true;
}

/**
 * Internal — fetch the plaintext key for the engine to use it.
 * NEVER expose the result of this function via HTTP. It exists so the
 * engine adapter inside the same Node process can authenticate to the
 * external LLM API.
 */
export async function getKeyPlaintext(provider: string, label?: string): Promise<VaultEntry | undefined> {
  const all = await readVault();
  const key = entryKey(provider, label);
  return all[key];
}

/**
 * Helper: pick the active default provider/key.
 * Looks for env CELIUMS_LLM_PROVIDER first, then falls back to the
 * lexicographically first stored entry.
 */
export async function getActiveKey(): Promise<VaultEntry | undefined> {
  const all = await readVault();
  const wanted = process.env.CELIUMS_LLM_PROVIDER;
  if (wanted) {
    const match = Object.values(all).find((e) => e.provider === wanted);
    if (match) return match;
  }
  return Object.values(all)[0];
}
