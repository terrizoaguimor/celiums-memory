// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * selectSecretProvider — env-driven factory.
 *
 * Reads `CELIUMS_SECRETS_BACKEND` and constructs the right provider:
 *
 *   env                 → EnvSecretProvider (default)
 *   file                → FileSecretProvider({ path: CELIUMS_SECRETS_PATH })
 *   sops-age            → FileSecretProvider (operator pre-decrypts)
 *   kubernetes          → K8sSecretProvider
 *   kubernetes-sealed   → K8sSecretProvider (sealed-secrets controller pre-decrypts)
 *   vault               → VaultSecretProvider
 *   aws-secretsmanager  → not bundled; throws SecretBackendUnavailable
 *                         with a pointer to docs/integrations/secrets/aws.md
 *   gcp-secretmanager   → same
 *   azure-keyvault      → same
 *
 * To plug a cloud-native adapter, implement `SecretProvider` in a
 * separate package and pass an instance directly — the factory exists
 * for the env-driven happy path.
 */

import type { SecretProvider, SecretsBackendId } from './types.js';
import { SecretBackendUnavailable } from './types.js';
import { EnvSecretProvider } from './env.js';
import { FileSecretProvider } from './file.js';
import { K8sSecretProvider } from './kubernetes.js';
import { VaultSecretProvider } from './vault.js';

export function selectSecretProvider(
  env: NodeJS.ProcessEnv = process.env,
): SecretProvider {
  const id = (env['CELIUMS_SECRETS_BACKEND'] ?? 'env') as SecretsBackendId;
  switch (id) {
    case 'env':
      return new EnvSecretProvider({
        ...(env['CELIUMS_SECRETS_ENV_PREFIX'] ? { prefix: env['CELIUMS_SECRETS_ENV_PREFIX'] } : {}),
      });

    case 'file':
    case 'sops-age': {
      const path = env['CELIUMS_SECRETS_PATH'];
      if (!path) {
        throw new SecretBackendUnavailable(id,
          `CELIUMS_SECRETS_PATH must be set when backend=${id}`);
      }
      return new FileSecretProvider({ path });
    }

    case 'kubernetes':
    case 'kubernetes-sealed':
      return new K8sSecretProvider({
        ...(env['CELIUMS_K8S_NAMESPACE']
          ? { namespace: env['CELIUMS_K8S_NAMESPACE'] }
          : {}),
        ...(env['CELIUMS_K8S_BUNDLE_SECRET']
          ? { bundleSecretName: env['CELIUMS_K8S_BUNDLE_SECRET'] }
          : {}),
      });

    case 'vault':
      return new VaultSecretProvider({
        ...(env['CELIUMS_VAULT_PATH'] ? { path: env['CELIUMS_VAULT_PATH'] } : {}),
      });

    case 'aws-secretsmanager':
    case 'gcp-secretmanager':
    case 'azure-keyvault':
      throw new SecretBackendUnavailable(id,
        `${id} adapter is not bundled with @celiums/memory. ` +
        `Implement the SecretProvider interface and pass an instance directly. ` +
        `See docs/integrations/secrets/${id}.md`);

    default: {
      const _exhaustive: never = id as never;
      throw new SecretBackendUnavailable(_exhaustive,
        `unknown CELIUMS_SECRETS_BACKEND: ${_exhaustive}`);
    }
  }
}
