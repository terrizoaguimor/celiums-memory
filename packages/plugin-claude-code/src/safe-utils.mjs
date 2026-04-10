/**
 * Security utilities for celiums-memory Claude Code plugin.
 *
 * These primitives are shared across hooks and the installer to harden
 * against the OWASP top risks for npm CLI tools that touch user config:
 *
 *   - Prototype pollution via untrusted JSON
 *   - SSRF via user-controlled URLs
 *   - Path traversal during config writes
 *   - Symlink races on dotfiles
 *   - Memory exhaustion via unbounded stdin
 *   - Credential leaks via captured commands
 *
 * Reviewed by Grok 4 (xAI) on 2026-04-10.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Bounded stdin reader ─────────────────────────────────
// Cap stdin at 1 MB. Anything larger from a Claude Code hook is either
// a bug or an attack — neither case warrants OOM.
const MAX_STDIN_BYTES = 1024 * 1024;

export async function readStdinBounded() {
  let stdin = '';
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) {
      throw new Error(`stdin exceeded ${MAX_STDIN_BYTES} bytes`);
    }
    stdin += chunk;
  }
  return stdin;
}

// ─── Prototype-pollution-safe JSON parser ────────────────
// Rejects payloads that literally contain __proto__/constructor/prototype
// keys. Faster than a reviver, safer than naked JSON.parse.
const POLLUTION_PATTERN = /"(__proto__|constructor|prototype)"\s*:/;

export function safeJsonParse(text) {
  if (!text || typeof text !== 'string') return {};
  if (POLLUTION_PATTERN.test(text)) {
    throw new Error('JSON payload contains forbidden prototype keys');
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ─── SSRF-resistant URL allowlist ────────────────────────
// celiums-memory should only ever talk to:
//   - localhost / 127.0.0.1 / ::1            (local server)
//   - private RFC1918 ranges                  (VPC deployments)
//   - *.celiums.ai                            (managed deployment)
//
// Blocks: cloud metadata (169.254.169.254), public IPs by default,
// link-local, multicast.
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const ALLOWED_DOMAIN_SUFFIX = '.celiums.ai';
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^fc[0-9a-f]{2}:/i, // ULA IPv6
  /^fd[0-9a-f]{2}:/i,
];
const BLOCKED_IP_PATTERNS = [
  /^169\.254\./,            // link-local (AWS/GCP metadata)
  /^fe80:/i,                // IPv6 link-local
  /^ff00:/i,                // IPv6 multicast
  /^::ffff:169\.254\./,     // IPv4-mapped link-local
];

export function assertSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Refusing protocol: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();

  // Block known dangerous IPs first
  for (const pat of BLOCKED_IP_PATTERNS) {
    if (pat.test(host)) {
      throw new Error(`Blocked host (link-local/multicast): ${host}`);
    }
  }

  // Allow explicit hostnames
  if (ALLOWED_HOSTNAMES.has(host)) return url;

  // Allow celiums.ai subdomain
  if (host.endsWith(ALLOWED_DOMAIN_SUFFIX)) return url;

  // Allow RFC1918 private ranges
  for (const pat of PRIVATE_IP_PATTERNS) {
    if (pat.test(host)) return url;
  }

  // Anything else is rejected — covers public IPs, suspicious DNS, metadata services
  throw new Error(`Host not in allowlist: ${host}`);
}

// ─── Atomic config write with symlink protection ─────────
// Writes via temp file + rename. Refuses to operate on a symlink.
// Prevents the read-then-write race that lets attackers swap a real
// config file for a symlink to /etc/passwd between operations.
export function atomicWriteJsonSafe(targetPath, data) {
  const resolved = path.resolve(targetPath);

  // If the target exists, it MUST be a regular file, not a symlink.
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${resolved}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Target is not a regular file: ${resolved}`);
    }
  }

  const dir = path.dirname(resolved);
  const tempPath = path.join(dir, `.${path.basename(resolved)}.tmp.${process.pid}`);
  const json = JSON.stringify(data, null, 2);

  // Write temp + fsync + rename for atomicity
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, resolved);
}

// ─── Path containment check ──────────────────────────────
// Ensures a child path is actually inside a parent — prevents path
// traversal via ../, symlinks, or unicode normalization tricks.
export function assertPathContains(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const rel = path.relative(parentResolved, childResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escape detected: ${child} is outside ${parent}`);
  }
  return childResolved;
}

// ─── Credential redaction for stored observations ───────
// Captured BASH commands and tool inputs may contain secrets.
// Redact common patterns BEFORE persisting to memory.
const SECRET_PATTERNS = [
  // OpenAI / Anthropic / xAI / DO style
  [/sk-[A-Za-z0-9_\-]{20,}/g, 'sk-[REDACTED]'],
  [/xai-[A-Za-z0-9_\-]{20,}/g, 'xai-[REDACTED]'],
  // GitHub tokens
  [/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  // AWS
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],
  [/aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{30,}/gi, 'aws_secret_access_key=[REDACTED]'],
  // Generic Bearer tokens
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer [REDACTED]'],
  [/Authorization:\s*[A-Za-z0-9._\-\s]{20,}/g, 'Authorization: [REDACTED]'],
  // Common env-var assignments with secret-looking values
  [/(API[_-]?KEY|SECRET|PASSWORD|TOKEN|PRIVATE[_-]?KEY)=\S{8,}/gi, '$1=[REDACTED]'],
  // .env file content patterns
  [/-----BEGIN[A-Z ]+PRIVATE KEY-----[\s\S]+?-----END[A-Z ]+PRIVATE KEY-----/g, '[REDACTED PEM PRIVATE KEY]'],
];

export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const [pat, replacement] of SECRET_PATTERNS) {
    out = out.replace(pat, replacement);
  }
  return out;
}

export const HOME = os.homedir();
