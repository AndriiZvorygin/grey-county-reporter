import assert from "node:assert/strict";
import test from "node:test";

import { isLocalOllamaHost, requireRemoteOllamaHost } from "../shared/remote-ollama.mjs";

test("Grey reporter rejects local Ollama endpoints", () => {
  for (const host of [
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://127.12.0.4:11434",
    "http://[::1]:11434",
  ]) {
    assert.equal(isLocalOllamaHost(host), true);
    assert.throws(() => requireRemoteOllamaHost(host), /local Ollama service/u);
  }
});

test("Grey reporter accepts the configured remote GPU host", () => {
  const host = "http://mriczo:11434";
  assert.equal(isLocalOllamaHost(host), false);
  assert.equal(requireRemoteOllamaHost(`${host}/`), host);
});
