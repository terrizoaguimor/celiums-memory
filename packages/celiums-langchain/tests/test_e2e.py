"""E2E tests for celiums-langchain against production server."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from celiums_langchain.client import CeliumsClient

API_KEY = os.environ.get("CELIUMS_API_KEY", "")
URL = os.environ.get("CELIUMS_URL", "https://memory.celiums.ai")

if not API_KEY:
    print("ERROR: Set CELIUMS_API_KEY environment variable to run E2E tests")
    sys.exit(1)
TEST_USER = f"pytest-e2e-{int(__import__('time').time())}"

passed = 0
failed = 0


async def test(name, coro):
    global passed, failed
    try:
        result = await coro
        print(f"✅ {name}{f' — {result}' if result else ''}")
        passed += 1
    except Exception as e:
        print(f"❌ {name} — {e}")
        failed += 1


async def main():
    async with CeliumsClient(api_key=API_KEY, url=URL, user_id=TEST_USER) as client:
        # Health
        await test("health", health(client))

        # Store
        await test("store memory", store(client))

        # Recall
        await test("recall memory", recall(client))

        # Emotion
        await test("emotion PAD state", emotion(client))

        # Forage (should fail without atlas_key)
        await test("forage blocked without atlas", forage_blocked(client))

    # Test with atlas_key
    async with CeliumsClient(api_key=API_KEY, url=URL, user_id=TEST_USER, atlas_key="test") as client:
        await test("forage with atlas_key", forage_ok(client))

    print(f"\n{'='*40}")
    print(f"{passed} passed, {failed} failed out of {passed + failed}")
    if failed > 0:
        sys.exit(1)


async def health(client):
    data = await client.health()
    assert data["status"] == "alive", f"status: {data.get('status')}"
    return f"modules: {data.get('knowledge', {}).get('moduleCount')}"


async def store(client):
    data = await client.store("Python test: user prefers Rust over Go", tags=["test", "languages"])
    assert data.get("stored"), "stored is falsy"
    return f"id: {data['memory']['id']}"


async def recall(client):
    data = await client.recall("Rust Go languages")
    assert data.get("found", 0) > 0, "found 0 memories"
    return f"found: {data['found']}"


async def emotion(client):
    data = await client.emotion()
    assert "state" in data or "pleasure" in data, f"unexpected format: {list(data.keys())}"
    state = data.get("state", data)
    return f"P={state['pleasure']:.2f} A={state['arousal']:.2f}"


async def forage_blocked(client):
    try:
        await client.forage("kubernetes")
        raise AssertionError("Should have raised PermissionError")
    except PermissionError:
        return "correctly blocked"


async def forage_ok(client):
    data = await client.forage("kubernetes", limit=2)
    results = data.get("results", data.get("modules", []))
    assert len(results) > 0, "no results"
    return f"{len(results)} modules found"


asyncio.run(main())
