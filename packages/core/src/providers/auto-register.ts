// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Side-effect module that registers all built-in provider adapters.
 *
 * Import once at server bootstrap (`import './providers/auto-register.js'`)
 * to populate the registry. After this import, `createProvider(id, config)`
 * works for: ollama, openai, do-inference, groq, openrouter, together,
 * lmstudio, vllm, custom, anthropic.
 */

import './ollama.js';
import './openai.js';
import './anthropic.js';
