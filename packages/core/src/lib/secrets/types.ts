// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SecretProvider — implements ADR-005.
 *
 * A single abstraction over the secret backends a deployment may run
 * against:
 *
 *   - env (default)
 *   - file (dotenv-style; pairs with SOPS for encrypted files)
 *   - kubernetes (in-cluster Secrets API)
 *   - vault (HashiCorp Vault KV2)
 *   - cloud-native (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault)
 *     — adapters published separately; the interface is stable.
 *
 * Callers ask for a secret by NAME. The provider returns the cleartext
 * value or throws. The interface deliberately exposes only `get` as a
 * mandatory method; rotation + audit are optional capabilities so a
 * deployment using `env` doesn't need to pretend it can rotate.
 */

/** A secret access event — surfaced by providers that audit reads. */
export interface SecretAccessRecord {
  /** Secret name. */
  name: string;
  /** ISO-8601 timestamp of the read. */
  accessedAt: string;
  /** Optional principal who asked. The provider may not know this. */
  by?: string;
  /** Backend-specific extra context. */
  metadata?: Record<string, unknown>;
}

export interface SecretProvider {
  /** Stable backend id. Matches `CELIUMS_SECRETS_BACKEND`. */
  readonly id: SecretsBackendId;
  /** Human-readable name for the dashboard. */
  readonly name: string;

  /** Fetch the cleartext value for `name`. Throws SecretNotFound or
   *  SecretBackendUnavailable on failure. */
  get(name: string): Promise<string>;

  /** Optional capability — rotate the named secret. Throws
   *  SecretBackendUnavailable if the backend doesn't support it. */
  rotate?(name: string): Promise<void>;

  /** Optional capability — audit trail of reads. Returns an async
   *  iterable; consumers iterate to drain. */
  audit?(): AsyncIterable<SecretAccessRecord>;

  /** Optional health probe — used by `/readyz`. Returns true when the
   *  backend is reachable + responsive. */
  healthy?(): Promise<boolean>;
}

export type SecretsBackendId =
  | 'env'
  | 'file'
  | 'kubernetes'
  | 'kubernetes-sealed'   // alias of 'kubernetes' for docs; same code path
  | 'sops-age'            // file backend with implicit SOPS pre-decrypt
  | 'vault'
  | 'aws-secretsmanager'
  | 'gcp-secretmanager'
  | 'azure-keyvault';

/** Thrown when a name doesn't exist in the backend. */
export class SecretNotFound extends Error {
  readonly code = 'SECRET_NOT_FOUND' as const;
  constructor(name: string, backend: string) {
    super(`Secret "${name}" not found in backend "${backend}"`);
    this.name = 'SecretNotFound';
  }
}

/** Thrown when the backend itself is unreachable / misconfigured. */
export class SecretBackendUnavailable extends Error {
  readonly code = 'SECRET_BACKEND_UNAVAILABLE' as const;
  constructor(backend: string, reason: string) {
    super(`Secrets backend "${backend}" unavailable: ${reason}`);
    this.name = 'SecretBackendUnavailable';
  }
}
