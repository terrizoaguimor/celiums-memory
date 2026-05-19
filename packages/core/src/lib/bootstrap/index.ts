// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Auto-bootstrap module — implements ADR-025.
 *
 * Public surface:
 *   - Stores: MemoryBootstrapStore, ValkeyBootstrapStore
 *   - Composer: composeBootstrap (delegates to turn_context)
 *   - Wrapper: shouldBootstrap, wrapToolResponse, serialiseWrapped
 *   - Helpers: deriveSessionId, generateSessionId, newRecord, renderBootstrap
 *   - Types: BootstrapStore, BootstrapContent, WrappedResponse, etc.
 */

export type {
  BootstrapContent, BootstrapRecord, BootstrapStore,
  BootstrapComposerInput, WrappedResponse, BootstrapDecision,
} from './types.js';

export {
  MemoryBootstrapStore, ValkeyBootstrapStore,
  BOOTSTRAP_DEFAULT_TTL_MS,
  type ValkeyStoreOptions as BootstrapValkeyStoreOptions,
} from './stores.js';

export {
  composeBootstrap, renderBootstrap,
  deriveSessionId, generateSessionId, newRecord,
  newRecord as newBootstrapRecord,
  DEFAULT_BOOTSTRAP_CHANNELS,
  type TurnContextFn,
} from './composer.js';

export {
  shouldBootstrap, wrapToolResponse, serialiseWrapped,
  type BootstrapWrapperOptions, type ShouldBootstrapInput,
} from './wrapper.js';

export {
  buildBootstrapMetrics, makeBootstrapObserver,
  type BootstrapMetrics,
} from './observability.js';
