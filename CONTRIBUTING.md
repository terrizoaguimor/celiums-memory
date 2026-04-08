# Contributing to Celiums Memory

First off — thank you. Every contribution, no matter how small, makes Celiums Memory better for everyone.

This document covers everything you need to go from zero to merged PR.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Issue Guidelines](#issue-guidelines)
- [Release Process](#release-process)
- [Getting Help](#getting-help)

---

## Code of Conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

**TL;DR:** Be kind. Be constructive. Assume good intent. No harassment, discrimination, or gatekeeping.

Violations can be reported to [conduct@celiums.ai](mailto:conduct@celiums.ai).

---

## Ways to Contribute

You don't have to write code to contribute.

| Type | How |
|------|-----|
| 🐛 **Bug reports** | Open a GitHub issue with reproduction steps |
| 💡 **Feature ideas** | Start a GitHub Discussion |
| 📖 **Documentation** | Fix typos, improve clarity, add examples |
| 🧪 **Tests** | Increase coverage, add edge case tests |
| 🌍 **Translations** | Help translate docs and UI strings |
| 🔌 **Integrations** | Build adapters for new AI tools |
| 📦 **Knowledge modules** | Create domain-specific memory packs |
| 💬 **Community** | Answer questions on Discord and GitHub |

---

## Development Setup

### Prerequisites

- **Node.js** 20+ — [nodejs.org](https://nodejs.org)
- **pnpm** 9+ — `npm install -g pnpm`
- **Docker** + **Docker Compose** — [docker.com](https://docker.com)
- **Git** 2.30+

### Step 1: Fork and Clone

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/YOUR_USERNAME/memory.git
cd memory

# Add upstream remote
git remote add upstream https://github.com/celiums/memory.git
```

### Step 2: Install Dependencies

```bash
pnpm install
```

### Step 3: Start Infrastructure

```bash
# Start PostgreSQL, Qdrant, and Valkey
pnpm docker:up

# Verify everything is healthy
docker compose -f docker/docker-compose.yml ps
```

### Step 4: Configure Environment

```bash
cp docker/.env.example .env.local
# Edit .env.local with your settings
# At minimum, set CELIUMS_API_KEY and OPENAI_API_KEY (or use Ollama)
```

### Step 5: Run Database Migrations

```bash
pnpm db:migrate
```

### Step 6: Start Development Server

```bash
pnpm dev
```

The server will be running at `http://localhost:3456`.

### Verify Setup

```bash
curl http://localhost:3456/health
# Should return: {"status":"ok",...}
```

---

## Project Structure

```
celiums/memory
├── packages/
│   ├── types/          # @celiums/types — Shared TypeScript types and schemas
│   ├── core/           # @celiums/core — Core SDK (store, search, retrieve)
│   ├── server/         # @celiums/server — HTTP + WebSocket + MCP server
│   ├── adapter-mcp/    # @celiums/adapter-mcp — MCP protocol adapter
│   └── cli/            # @celiums/cli — Command line interface
├── apps/
│   └── docs/           # Documentation website
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── .env.example
├── examples/           # Integration examples
└── scripts/            # Build and release scripts
```

### Package Dependency Graph

```
types
  └── core
        ├── server
        │     └── (deployed)
        └── adapter-mcp
              └── (deployed)
cli
  └── core
```

---

## Development Workflow

### Branching Strategy

We use **trunk-based development** with short-lived feature branches.

```
main              — stable, always deployable
  └── feat/...    — new features (branch from main)
  └── fix/...     — bug fixes (branch from main)
  └── docs/...    — documentation (branch from main)
  └── chore/...   — maintenance (branch from main)
```

### Branch Naming

```bash
feat/add-memory-expiry
fix/qdrant-connection-timeout
docs/improve-mcp-setup-guide
chore/upgrade-postgres-17
```

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation only
- `test` — adding or fixing tests
- `refactor` — code change that neither fixes a bug nor adds a feature
- `perf` — performance improvement
- `chore` — build process, dependency updates
- `ci` — CI/CD changes

**Examples:**

```bash
feat(core): add memory expiry with TTL support
fix(server): handle qdrant connection timeout gracefully
docs(readme): add Cursor integration example
test(core): add edge cases for similarity search
perf(server): cache embedding results in Valkey
```

---

## Coding Standards

### TypeScript

- **Strict mode** is enabled and non-negotiable
- Prefer `type` over `interface` for object shapes (use `interface` for extension)
- No `any` — use `unknown` and narrow types
- Explicit return types on all exported functions
- Use `satisfies` operator for type-safe object literals

```typescript
// ✅ Good
export async function searchMemories(
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  // ...
}

// ❌ Bad
export async function searchMemories(query, options) {
  // ...
}
```

### Error Handling

Always use typed errors. Never swallow errors silently.

```typescript
// ✅ Good
import { CeliumsError, ErrorCode } from '@celiums/types'

if (!memory) {
  throw new CeliumsError({
    code: ErrorCode.MEMORY_NOT_FOUND,
    message: `Memory ${id} not found`,
    context: { id },
  })
}

// ❌ Bad
if (!memory) {
  throw new Error('not found')
}
```

### File Organization

```
src/
├── index.ts          # Public API exports only
├── types.ts          # Local types (if not in @celiums/types)
├── constants.ts      # Constants
├── utils/            # Pure utility functions
├── services/         # Business logic
└── __tests__/        # Tests co-located with source
```

### Formatting

We use **Prettier** with the project config. Run before committing:

```bash
pnpm format
```

### Linting

```bash
pnpm lint        # Check
pnpm lint:fix    # Auto-fix
```

---

## Testing

### Running Tests

```bash
# All packages
pnpm test

# Specific package
pnpm --filter @celiums/core test

# Watch mode
pnpm --filter @celiums/core test -- --watch

# Coverage
pnpm test:coverage
```

### Test Structure

We use **Vitest**. Tests live in `src/__tests__/` or alongside source files as `*.test.ts`.

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MemoryManager } from '../memory-manager.js'

describe('MemoryManager', () => {
  let manager: MemoryManager

  beforeEach(() => {
    manager = new MemoryManager({ /* mock config */ })
  })

  describe('store', () => {
    it('stores a memory and returns an id', async () => {
      const result = await manager.store({
        content: 'Test memory',
        type: 'fact',
      })

      expect(result.id).toMatch(/^mem_/)
      expect(result.content).toBe('Test memory')
    })

    it('throws when content is empty', async () => {
      await expect(
        manager.store({ content: '', type: 'fact' })
      ).rejects.toThrow('Content cannot be empty')
    })
  })
})
```

### Coverage Requirements

- **New features:** 80% minimum coverage
- **Bug fixes:** Must include a regression test
- **Critical paths** (store, search, retrieve): 90%+ coverage

---

## Submitting a Pull Request

### Before You Open a PR

- [ ] Tests pass: `pnpm test`
- [ ] Types check: `pnpm typecheck`
- [ ] Linting passes: `pnpm lint`
- [ ] Formatting is correct: `pnpm format:check`
- [ ] You've added tests for new functionality
- [ ] You've updated documentation if needed
- [ ] Your branch is up to date with `main`

### PR Title

Follow the same Conventional Commits format:

```
feat(core): add memory expiry with TTL support
```

### PR Description Template

```markdown
## What does this PR do?

Brief description of the change.

## Why?

The motivation or problem being solved.

## How?

Technical approach taken.

## Testing

How you tested this change.

## Screenshots / Examples

If applicable.

## Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Changeset added (for user-facing changes)
```

### Changeset (for user-facing changes)

```bash
pnpm changeset
# Follow the prompts to describe your change
# This generates a changeset file — commit it with your PR
```

### Review Process

1. A maintainer will review within **2 business days**
2. Address feedback with new commits (don't force-push during review)
3. Once approved, a maintainer will squash-merge your PR
4. Your contribution will appear in the next release notes

---

## Issue Guidelines

### Bug Reports

Use the **Bug Report** template. Include:

1. **What happened** — exact error message or unexpected behavior
2. **What you expected** — what should have happened
3. **Reproduction steps** — minimal steps to reproduce
4. **Environment** — OS, Node version, Docker version, Celiums version
5. **Logs** — relevant logs from `docker compose logs`

### Feature Requests

Use the **Feature Request** template or start a **GitHub Discussion** first for larger ideas.

Include:
- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered
- Who else would benefit from this

### Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Email [security@celiums.ai](mailto:security@celiums.ai) with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We'll respond within 48 hours and coordinate a responsible disclosure.

---

## Release Process

Releases are managed by maintainers using [Changesets](https://github.com/changesets/changesets).

1. PRs include changeset files describing the change
2. Maintainers run `pnpm version-packages` to bump versions
3. A release PR is opened automatically
4. On merge, packages are published to npm and a GitHub release is created

---

## Getting Help

Stuck? We're here.

- **Discord `#contributing`** — fastest response: [discord.gg/celiums](https://discord.gg/celiums)
- **GitHub Discussions** — for longer questions
- **Email** — [hello@celiums.ai](mailto:hello@celiums.ai)

---

Thank you for making Celiums Memory better. 🧠

— Celiums Solutions LLC