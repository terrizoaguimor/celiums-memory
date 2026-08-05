// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** POST JSON with bounded exponential backoff for transient inference failures. */
export async function inferencePost(url: string, init: RequestInit): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, init);
    if (!RETRYABLE_STATUS.has(response.status)) return response;
    lastResponse = response;
    await response.body?.cancel();
    if (attempt + 1 < MAX_ATTEMPTS) {
      const jitter = Math.floor(Math.random() * 250);
      await delay(1_000 * 2 ** attempt + jitter);
    }
  }
  return lastResponse as Response;
}
