# Changelog

All notable changes to celiums-memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-08

### Added
- Complete 3-layer cognitive architecture (Metacognition, Limbic, Autonomic)
- 14 core modules: personality, theory_of_mind, habituation, pfc, limbic, importance, store, recall, nervous, reward, interoception, circadian, consolidate, lifecycle
- PAD emotional model (Pleasure, Arousal, Dominance) with continuous 3D state
- Big Five (OCEAN) personality traits mapped to mathematical constants
- Theory of Mind via Empathic Friction Matrix (3x3)
- Dopamine Reward Prediction Error with sigmoid saturation and habituation
- Prefrontal Cortex regulation with bidirectional neuroplasticity
- Circadian rhythms with lethargy and wake-up mechanics
- Hardware interoception (CPU/RAM/latency → emotional stress) with EMA smoothing
- ANS modulation (auto-tune LLM temperature, topK, maxTokens by emotion)
- SAR attention filter with Yerkes-Dodson inverted-U
- Ebbinghaus forgetting curve with spaced repetition reactivation
- In-memory store for zero-dependency development
- Production store (PostgreSQL 17 + pgvector, Qdrant, Valkey)
- Distributed Valkey mutex for concurrent state updates
- REST API server (9 endpoints)
- MCP adapter (5 tools: remember, recall, forget, context, consolidate)
- LangChain adapter (BaseMemory implementation)
- LlamaIndex adapter (ChatStore implementation)
- CLI (start, recall, stats, forget, export, import)
- Memory Middleware for automatic LLM memory wrapping
- Docker Compose for production deployment
- 26/26 stress tests passing
- 6 personality presets (celiums, therapist, creative, engineer, anxious, balanced)
- 10 mathematical equations grounded in neuroscience
