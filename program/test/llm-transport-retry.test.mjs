import assert from "node:assert/strict";
import test from "node:test";
import { requestOllamaChat } from "../../../../../program/library/reporter_shared/whole-meeting-synthesis.mjs";
import { DEFAULT_TEXT_MODEL } from "../../../../../program/runtime/gpu/text-model.mjs";
import {
  hearRetryDelayMs,
  isRetryableHearError,
} from "../../../../house/owen-sound-reporter/program/shared/qwen-hear-retry.mjs";

test("whole-meeting Ollama requests retry transport failures inside generation", async () => {
  const calls = [];
  const sleeps = [];
  let attempt = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    attempt += 1;
    if (attempt === 1) throw new TypeError("fetch failed");
    if (attempt === 2) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ message: { content: "grounded result" } }) };
  };

  const result = await requestOllamaChat(
    [{ role: "user", content: "source" }],
    { fetchImpl, retryAttempts: 3, retryDelayMs: 0, sleepImpl: async (ms) => sleeps.push(ms) },
  );

  assert.equal(result, "grounded result");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ url }) => url.endsWith("/api/chat")));
  assert.ok(calls.every(({ body }) => body.model === DEFAULT_TEXT_MODEL));
  assert.deepEqual(sleeps, [0, 0]);
});

test("hear retry policy treats backend allocation failures as retryable and backs off", () => {
  assert.equal(isRetryableHearError("Qwen3ASRLoader: Allocation on device 0 would exceed allowed memory"), true);
  assert.equal(isRetryableHearError("CUDA error: operation not permitted"), true);
  assert.equal(isRetryableHearError("invalid audio format"), false);
  assert.equal(hearRetryDelayMs(1, { baseMs: 1000, maxMs: 5000 }), 1000);
  assert.equal(hearRetryDelayMs(2, { baseMs: 1000, maxMs: 5000 }), 2000);
  assert.equal(hearRetryDelayMs(4, { baseMs: 1000, maxMs: 5000 }), 5000);
});
