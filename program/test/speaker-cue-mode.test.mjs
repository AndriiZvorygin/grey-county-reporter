import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Grey uses the shared anonymous sentence policy by default", () => {
  const source = fs.readFileSync(new URL("../run-full-transcript-pipeline.mjs", import.meta.url), "utf8");
  assert.match(source, /buildSentenceDiarizationEnv/u);
  assert.match(source, /speakerArtifactUsesDefaultLabels/u);
  assert.match(source, /skipWhen: \(\) => !namedSpeakerIdentity/u);
  assert.doesNotMatch(source, /PYA_SPEAKER_REASSIGN_PASS/u);
  assert.doesNotMatch(source, /PYA_SPEAKER_RELABEL_MODE/u);
});
