// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Three sync modes — ADR-022. See ./types.ts for the contract.
 */

export * from './types.js';
export {
  SCRYPT_KDF,
  AES_256_GCM_CIPHER,
  ZkSyncEngine,
  PlaintextSyncEngine,
  makeLibsodiumKdf,
  makeLibsodiumCipher,
} from './zk-crypto.js';
export {
  defaultModeForTier,
  commitInstallChoice,
  planModeMigration,
  type Tier,
  type InstallWizardOpts,
  type MigrationPlan,
} from './mode-selector.js';
export {
  generateDeviceKeypair,
  generateMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  InMemoryKeyVault,
  type DeviceKeypair,
  type WrappedKey,
  type KeyVault,
} from './key-management.js';
export {
  StubLocalEmbedder,
  HashEmbedder,
  verifyEmbedder,
  vectorDimMatches,
  type LocalEmbedder,
  type EmbedderModel,
} from './local-embedder.js';
