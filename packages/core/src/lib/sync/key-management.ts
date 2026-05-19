// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Key management — implements ADR-022 §"Key sync across devices".
 *
 * Two flows are surfaced:
 *
 *  A) Device-only master.
 *     The user types the passphrase on each device. The master key
 *     stays on the device. This is the default — operator-deployable
 *     without `keys.celiums.ai`. Survives even when keys.celiums.ai
 *     is offline. Cost: the user types on each device.
 *
 *  B) Wrapped-key sync (opt-in).
 *     The user generates a device keypair on first install. Their
 *     master key is wrapped under each device's public key; the
 *     wrapped form is synced via keys.celiums.ai. To add a new
 *     device, the user generates that device's keypair, ships its
 *     public key to keys.celiums.ai, and an already-trusted device
 *     authorises the wrap. The new device unwraps locally; the
 *     plaintext master never leaves a device.
 *
 * This module exposes the contract; the actual asymmetric wrap relies
 * on libsodium box (or NaCl-compatible alternative). The default
 * impl falls back to RSA-OAEP via node:crypto when libsodium isn't
 * available; tests can substitute a stub.
 */

import {
  generateKeyPairSync, publicEncrypt, privateDecrypt, randomBytes, constants,
  createPublicKey, createPrivateKey,
} from 'node:crypto';
import { SyncError } from './types.js';

export interface DeviceKeypair {
  /** Base64url of the public key in SPKI DER form. */
  publicKey: string;
  /** Base64url of the private key in PKCS8 DER form. Held only on the
   *  device's secure store (keychain, libsecret, DPAPI). NEVER synced. */
  privateKey: string;
  /** Stable identifier the operator assigns (e.g. 'mario-mbp-2026'). */
  deviceId: string;
}

export interface WrappedKey {
  forDeviceId: string;
  /** Base64url ciphertext of the master key under that device's public key. */
  wrapped: string;
  /** ISO timestamp when the wrap was generated. */
  wrappedAt: string;
  /** ID of the device that performed the wrap (audit trail). */
  authorisedByDeviceId: string;
}

export interface KeyVault {
  /** Persist a wrapped-key entry. The vault is `keys.celiums.ai`-like:
   *  it sees ciphertext only; the wrap algorithm is opaque to it. */
  putWrapped(entry: WrappedKey): Promise<void>;
  /** Fetch a wrapped-key entry for a device. */
  getWrapped(deviceId: string): Promise<WrappedKey | null>;
  /** List all devices currently registered for a user. */
  listDevices(): Promise<DeviceKeypair[]>;
  /** Register a new device's public key. The device's private key
   *  is NEVER stored here. */
  registerDevice(input: { deviceId: string; publicKey: string }): Promise<void>;
}

/** Generate a new RSA-4096 device keypair. RSA-4096 is the conservative
 *  default; operators wiring libsodium can substitute X25519. */
export function generateDeviceKeypair(deviceId: string): DeviceKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: Buffer.from(publicKey).toString('base64url'),
    privateKey: Buffer.from(privateKey).toString('base64url'),
    deviceId,
  };
}

/** Wrap the master key for a target device. RSA-OAEP-SHA256.
 *  Output is base64url ciphertext. */
export function wrapMasterKey(
  masterKey: Uint8Array,
  targetDevicePubKeyB64: string,
): string {
  if (masterKey.length !== 32) {
    throw new SyncError('cloud-synced', 'wrapMasterKey', `master key must be 32 bytes, got ${masterKey.length}`);
  }
  const pubDer = Buffer.from(targetDevicePubKeyB64, 'base64url');
  const pubKey = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const ct = publicEncrypt({
    key: pubKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, Buffer.from(masterKey));
  return ct.toString('base64url');
}

/** Unwrap a master key using the local device's private key. */
export function unwrapMasterKey(
  wrappedB64: string,
  deviceKeypair: DeviceKeypair,
): Uint8Array {
  const privDer = Buffer.from(deviceKeypair.privateKey, 'base64url');
  const privKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const pt = privateDecrypt({
    key: privKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, Buffer.from(wrappedB64, 'base64url'));
  if (pt.length !== 32) {
    throw new SyncError('cloud-synced', 'unwrapMasterKey',
      `unwrapped key length ${pt.length} != 32 — wrong key or corrupt blob`);
  }
  return new Uint8Array(pt);
}

/** Generate a fresh 32-byte master key. */
export function generateMasterKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** In-memory KeyVault — tests + the install wizard's "single device"
 *  default. Production wires a real `keys.celiums.ai`-backed impl. */
export class InMemoryKeyVault implements KeyVault {
  private readonly wrapped = new Map<string, WrappedKey>();
  private readonly devices = new Map<string, DeviceKeypair>();

  async putWrapped(entry: WrappedKey): Promise<void> {
    this.wrapped.set(entry.forDeviceId, { ...entry });
  }
  async getWrapped(deviceId: string): Promise<WrappedKey | null> {
    return this.wrapped.get(deviceId) ?? null;
  }
  async listDevices(): Promise<DeviceKeypair[]> {
    return [...this.devices.values()].map((d) => ({ ...d }));
  }
  async registerDevice(input: { deviceId: string; publicKey: string }): Promise<void> {
    // store ONLY the public key portion + deviceId. privateKey stays
    // on the device's local secure store.
    this.devices.set(input.deviceId, {
      deviceId: input.deviceId,
      publicKey: input.publicKey,
      privateKey: '',
    });
  }
}
