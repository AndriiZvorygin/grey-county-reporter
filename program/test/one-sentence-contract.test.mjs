import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { generateOneSentenceSummaryLlm } from "../run-full-transcript-pipeline.mjs";

test("Grey full-meeting teaser retries malformed Qwen shape with a fresh LLM contract", async (t) => {
  const originalFetch = globalThis.fetch;
  const envNames = [
    "OLLAMA_HOST",
    "PYA_RUNTIME_FILE",
    "PYA_TEXT_MODEL",
    "PYA_GPU_HOUSEKEEPER_URL",
    "GPU_HOUSEKEEPER_URL",
    "PYA_GPU_MANAGER_REQUIRED",
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  let calls = 0;
  const prompts = [];
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    assert.equal(request.model, "qwen3.5:9b");
    prompts.push(request.messages[1].content);
    const content = calls === 1
      ? "Too short."
      : "The Committee of the Whole reviewed transit planning, a regional transit study, an official plan approval, and committee minutes during the complete meeting.";
    return {
      ok: true,
      async json() {
        return { message: { content } };
      },
    };
  };
  process.env.OLLAMA_HOST = "http://test-ollama:11434";
  process.env.PYA_RUNTIME_FILE = new URL("../../conduct/runtime.pya", import.meta.url).pathname;
  delete process.env.PYA_TEXT_MODEL;
  delete process.env.PYA_GPU_HOUSEKEEPER_URL;
  delete process.env.GPU_HOUSEKEEPER_URL;
  process.env.PYA_GPU_MANAGER_REQUIRED = "0";
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  const result = await generateOneSentenceSummaryLlm({
    summaryMd: "The meeting covered the complete chronology, including transit planning, an official plan approval, and committee minutes.",
    hookTitle: "Unified Regional Transit Network",
    jurisdiction: "Grey County",
    body: "Committee of the Whole",
    dateLong: "September 24, 2026",
  });

  assert.equal(calls, 2);
  assert.match(prompts[1], /REJECTION_REASON:.*invalid one-sentence shape/iu);
  assert.match(prompts[1], /PRIOR_REJECTED_CANDIDATE:\s*Too short\./u);
  assert.equal(result, "The Committee of the Whole reviewed transit planning, a regional transit study, an official plan approval, and committee minutes during the complete meeting.");
});

test("Grey full-meeting teaser accepts a complete grounded sentence just above the cosmetic word target", async (t) => {
  const originalFetch = globalThis.fetch;
  const envNames = [
    "OLLAMA_HOST",
    "PYA_RUNTIME_FILE",
    "PYA_TEXT_MODEL",
    "PYA_GPU_HOUSEKEEPER_URL",
    "GPU_HOUSEKEEPER_URL",
    "PYA_GPU_MANAGER_REQUIRED",
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  let calls = 0;
  const candidate = "The County Council reviewed transit planning, a regional transit study, an official plan approval, committee minutes, and related public works decisions during its October meeting and discussion of regional priorities and service changes.";
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    assert.equal(request.model, "qwen3.5:9b");
    return {
      ok: true,
      async json() {
        return { message: { content: candidate } };
      },
    };
  };
  process.env.OLLAMA_HOST = "http://test-ollama:11434";
  process.env.PYA_RUNTIME_FILE = new URL("../../conduct/runtime.pya", import.meta.url).pathname;
  delete process.env.PYA_TEXT_MODEL;
  delete process.env.PYA_GPU_HOUSEKEEPER_URL;
  delete process.env.GPU_HOUSEKEEPER_URL;
  process.env.PYA_GPU_MANAGER_REQUIRED = "0";
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  const result = await generateOneSentenceSummaryLlm({
    summaryMd: "The meeting covered transit planning, an official plan approval, committee minutes, and related public works decisions.",
    hookTitle: "Regional Transit Network",
    jurisdiction: "Grey County",
    body: "County Council",
    dateLong: "October 8, 2026",
  });

  assert.equal(calls, 1);
  assert.equal(result, candidate);
});

test("Grey full-meeting teaser accepts a grounded forty-word-bound sentence", async (t) => {
  const originalFetch = globalThis.fetch;
  const envNames = [
    "OLLAMA_HOST",
    "PYA_RUNTIME_FILE",
    "PYA_TEXT_MODEL",
    "PYA_GPU_HOUSEKEEPER_URL",
    "GPU_HOUSEKEEPER_URL",
    "PYA_GPU_MANAGER_REQUIRED",
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const candidate = "The County Council reviewed housing, transportation, emergency services, public works, a regional planning study, committee minutes, and related service decisions during its complete October meeting and discussion of county priorities, including regional partners, budget planning, and implementation updates.";
  assert.equal(candidate.split(/\s+/u).filter(Boolean).length, 38);
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, "qwen3.5:9b");
    return {
      ok: true,
      async json() {
        return { message: { content: candidate } };
      },
    };
  };
  process.env.OLLAMA_HOST = "http://test-ollama:11434";
  process.env.PYA_RUNTIME_FILE = new URL("../../conduct/runtime.pya", import.meta.url).pathname;
  delete process.env.PYA_TEXT_MODEL;
  delete process.env.PYA_GPU_HOUSEKEEPER_URL;
  delete process.env.GPU_HOUSEKEEPER_URL;
  process.env.PYA_GPU_MANAGER_REQUIRED = "0";
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  const result = await generateOneSentenceSummaryLlm({
    summaryMd: "The meeting covered housing, transportation, emergency services, public works, a regional planning study, committee minutes, and related county service decisions.",
    hookTitle: "County Priorities",
    jurisdiction: "Grey County",
    body: "County Council",
    dateLong: "October 22, 2026",
  });

  assert.equal(result, candidate);
});

test("Grey prose stages keep failed generation retryable", () => {
  const source = fs.readFileSync(new URL("../run-grey-county-meeting-from-ref.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fallbackMeetingSummaryMd|extractLeadingSentence|No summary available\./u);
  assert.match(source, /job remains retryable/u);

  const greyFullPipeline = fs.readFileSync(
    new URL("../run-full-transcript-pipeline.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(greyFullPipeline, /buildOneSentenceSummary|firstSentence|fallbackLead/u);
  assert.match(greyFullPipeline, /generateOneSentenceSummaryLlm/u);
  assert.match(greyFullPipeline, /requestManagedOllamaChat/u);
  assert.doesNotMatch(greyFullPipeline, /model:\s*["'](?:qwen3\.5:9b|llama3\.2)/iu);

  const picker = fs.readFileSync(new URL("../../../../../command/run_next_unposted_story.mjs", import.meta.url), "utf8");
  assert.match(picker, /posted_remote_transcript: true/u);
  assert.match(picker, /posted_transcript: true/u);
});
