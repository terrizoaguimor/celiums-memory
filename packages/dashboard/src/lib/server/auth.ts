/**
 * Local auth — JSON file-backed user management.
 * Single admin user per VPS instance. Zero native dependencies.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const AUTH_PATH = process.env.CELIUMS_UI_DB?.replace('.db', '.json')
  || process.env.CELIUMS_AUTH_FILE
  || path.join(process.cwd(), 'celiums-auth.json');

// ── Data structure ──────────────────────────────────────────────

interface AuthData {
  user: {
    id: string;
    username: string;
    passwordHash: string;
    apiKey: string;
    createdAt: string;
  } | null;
  sessions: Array<{
    token: string;
    userId: string;
    expiresAt: string;
  }>;
}

let cache: AuthData | null = null;

function load(): AuthData {
  if (cache) return cache;
  try {
    if (fs.existsSync(AUTH_PATH)) {
      cache = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
      return cache!;
    }
  } catch { /* corrupt file — start fresh */ }
  cache = { user: null, sessions: [] };
  return cache;
}

function save(): void {
  const dir = path.dirname(AUTH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

// ── Password hashing (scrypt — same as before) ─────────────────

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const result = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(result, 'hex'));
}

// ── API key generation ──────────────────────────────────────────

// Honor the engine-provided key when one is present in the environment.
// On the 1-Click droplet, /etc/celiums/env declares CELIUMS_API_KEY (the
// SAME value the engine reads via loadOrCreateApiKey). Without this the
// dashboard mints its own random key on first signup, and the value the
// /settings page advertises has no relation to the one the engine
// validates Bearer requests against — which silently breaks every MCP
// integration.
function generateApiKey(): string {
  const provided = process.env.CELIUMS_API_KEY?.trim();
  if (provided && /^cmk_[A-Za-z0-9_-]+$/.test(provided)) return provided;
  return 'cmk_' + crypto.randomBytes(32).toString('base64url');
}

// ── Session cleanup ─────────────────────────────────────────────

function cleanExpiredSessions(): void {
  const data = load();
  const now = new Date().toISOString();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter(s => s.expiresAt > now);
  if (data.sessions.length !== before) save();
}

// Cleanup every 10 minutes
setInterval(cleanExpiredSessions, 600_000);

// ── Public API ──────────────────────────────────────────────────

export function hasUsers(): boolean {
  return load().user !== null;
}

const MAX_PASSWORD_LENGTH = 128;
const MAX_USERNAME_LENGTH = 64;
const MAX_SESSIONS = 10;

export function createUser(username: string, password: string): { apiKey: string } {
  const data = load();
  if (data.user) throw new Error('Admin user already exists');
  if (username.length > MAX_USERNAME_LENGTH) throw new Error('Username too long');
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('Password too long');

  const apiKey = generateApiKey();
  data.user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    passwordHash: hashPassword(password),
    apiKey,
    createdAt: new Date().toISOString(),
  };
  data.sessions = [];
  save();

  return { apiKey };
}

export function login(username: string, password: string): string | null {
  const data = load();
  if (!data.user) return null;
  if (data.user.username !== username) return null;
  if (!verifyPassword(password, data.user.passwordHash)) return null;

  // Create session token (7 days)
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  data.sessions.push({ token, userId: data.user.id, expiresAt });

  // Cap max sessions
  if (data.sessions.length > MAX_SESSIONS) {
    data.sessions = data.sessions.slice(-MAX_SESSIONS);
  }

  save();

  return token;
}

export function validateSession(token: string): { userId: string; username: string; apiKey: string } | null {
  const data = load();
  if (!data.user) return null;
  if (!token || token.length !== 64) return null;

  const now = new Date().toISOString();
  const tokenBuf = Buffer.from(token, 'hex');

  const session = data.sessions.find(s => {
    if (s.expiresAt <= now) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(s.token, 'hex'), tokenBuf);
    } catch { return false; }
  });
  if (!session) return null;

  return {
    userId: data.user.id,
    username: data.user.username,
    apiKey: data.user.apiKey,
  };
}

export function logout(token: string): void {
  const data = load();
  data.sessions = data.sessions.filter(s => s.token !== token);
  save();
}

export function getApiKey(userId: string): string | null {
  const data = load();
  return data.user?.id === userId ? data.user.apiKey : null;
}

export function regenerateApiKey(userId: string): string {
  const data = load();
  if (!data.user || data.user.id !== userId) throw new Error('User not found');
  const newKey = generateApiKey();
  data.user.apiKey = newKey;
  save();
  return newKey;
}
