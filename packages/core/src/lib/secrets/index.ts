// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Secrets module — implements ADR-005.
 *
 * Public surface:
 *   - SecretProvider interface
 *   - 4 bundled backends: env, file, kubernetes, vault
 *   - Factory: selectSecretProvider(env)
 *   - Log redaction: redactPatterns, redactStructured + extension hooks
 *   - Error types: SecretNotFound, SecretBackendUnavailable
 */

export type { SecretProvider, SecretsBackendId, SecretAccessRecord } from './types.js';
export { SecretNotFound, SecretBackendUnavailable } from './types.js';

export { EnvSecretProvider, type EnvProviderOptions } from './env.js';
export { FileSecretProvider, type FileProviderOptions, parseDotenv } from './file.js';
export { K8sSecretProvider, type K8sProviderOptions } from './kubernetes.js';
export { VaultSecretProvider, type VaultProviderOptions } from './vault.js';

export { selectSecretProvider } from './factory.js';

export {
  redactPatterns, redactStructured,
  registerSensitiveField, registerSecretPattern,
} from './redaction.js';
