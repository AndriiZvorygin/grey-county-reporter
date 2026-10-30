#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SUMMARY_FOCUS } from "./defaults.mjs";
import {
  buildGreyTranscriptArtifacts,
  existsArtifact,
  loadJsonArtifact,
  savePyaReportArtifact,
} from "./shared/artifact-contracts.mjs";
import { createStageRunner } from "./shared/stage-runner.mjs";
import { runQualityVerifiers } from "./shared/quality-verifiers.mjs";
import { verifyArticleClaims } from "../../../../program/library/reporter_shared/quality-verifiers.mjs";
import { GREY_ADAPTER } from "./writer-adapter-grey-county.mjs";
import { normalizePublishConfig } from "../../../../program/publisher-interface.mjs";
import { readPyaTextValues } from "../../../../command/pya_lookup.mjs";
import {
  requestManagedOllamaChat,
  resolveGpuHousekeeperUrl,
} from "../../../../program/runtime/gpu/managed-ollama.mjs";
import { resolveConfiguredText } from "../../../../program/runtime/gpu/configured-endpoints.mjs";
import { requireRemoteOllamaHost } from "./shared/remote-ollama.mjs";
import { canonicalMeetingRouteSlug } from "../../../../program/library/reporter_shared/meeting-route.mjs";
import {
  buildSentenceDiarizationEnv,
  namedSpeakerIdentityEnabled,
  speakerArtifactUsesDefaultLabels,
} from "../../../../program/library/reporter_shared/speaker-diarization-policy.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE = path.resolve(PROGRAM_DIR, "..");
const ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const SECRET_PATHS = [
  path.join(HOUSE, "configure/secret.pya"),
  path.join(ROOT, "configure/secret.pya"),
];
const SECRET_PATH = SECRET_PATHS.find((p) => fs.existsSync(p)) || SECRET_PATHS[0];
const GLOBAL_DEFAULTS_PATH = path.join(ROOT, "configure/default.pya");
const DEFAULT_SITE = "https://helpos.ca";
const DEFAULT_FOCUS = DEFAULT_SUMMARY_FOCUS;
const HARD_DEFAULT_SPEAKER_HOST = "http://mriczo:8010";
const HARD_DEFAULT_SPEAKER_HOST_ROOT = "/workplace";
const MEETING_ONE_SENTENCE_MIN_WORDS = 18;
// Keep the complete-meeting teaser bounded while matching the upstream Grey
// preview contract and allowing a multi-topic chronology to remain complete.
const MEETING_ONE_SENTENCE_MAX_WORDS = 40;

function usage() {
  return [
    "Usage: node program/run-full-transcript-pipeline.mjs <transcript_dir> [base_prefix] [focus] [jurisdiction] [body] [site_url] [discussion_url]",
    "Example: node ... artifacts/grey-county/meetings/<meeting>/transcript meeting-qwen-auto \"the main topics, evidence, decisions, and next steps discussed in the agenda, using a neutral, source-faithful lens\" \"Grey County\" \"County Council\" \"https://helpos.ca\" \"\"",
  ].join("\n");
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function ensureDir(dirPath) {
  const st = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`directory not found: ${dirPath}`);
}

function existsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existsDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function ensureWritableDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const probe = path.join(
    dirPath,
    `.write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(probe, "ok", "utf8");
  fs.unlinkSync(probe);
}

function fileMtimeMs(filePath) {
  try {
    return Number(fs.statSync(filePath).mtimeMs || 0);
  } catch {
    return 0;
  }
}

function hasMinSize(filePath, minBytes = 1) {
  try {
    return fs.statSync(filePath).isFile() && Number(fs.statSync(filePath).size || 0) >= minBytes;
  } catch {
    return false;
  }
}

function countSrtCues(filePath) {
  if (!existsFile(filePath)) return 0;
  const text = safeReadText(filePath, "");
  const m = String(text).match(/^\d\d:\d\d:\d\d,\d\d\d\s+-->\s+\d\d:\d\d:\d\d,\d\d\d$/gmu);
  return Array.isArray(m) ? m.length : 0;
}

function countSpeakerRowsJson(filePath) {
  if (!existsFile(filePath)) return 0;
  const obj = safeReadJson(filePath, {});
  const rows = Array.isArray(obj?.rows) ? obj.rows.length : 0;
  return Number.isFinite(rows) ? rows : 0;
}

function parseSrtCueRows(filePath) {
  if (!existsFile(filePath)) return [];
  const text = safeReadText(filePath, "");
  const lines = String(text).split(/\r?\n/gu);
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)$/u);
    if (!m) continue;
    rows.push({ start: m[1], end: m[2], startMs: srtTimestampToMs(m[1]), endMs: srtTimestampToMs(m[2]) });
  }
  return rows;
}

function srtTimestampToMs(ts) {
  const m = String(ts || "").match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)$/u);
  if (!m) return Number.NaN;
  return (((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) + Number(m[4]);
}

function summarizeCueTimeline(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let prevEnd = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const cue = rows[i] || {};
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) {
      throw new Error(`[timing-contract] malformed cue timestamp at cue=${i + 1}`);
    }
    if (cue.endMs <= cue.startMs) {
      throw new Error(`[timing-contract] invalid cue bounds at cue=${i + 1}: ${cue.start} --> ${cue.end}`);
    }
    if (cue.startMs < prevEnd) {
      throw new Error(`[timing-contract] non-monotonic/overlap at cue=${i + 1}: ${cue.start} starts before previous end`);
    }
    prevEnd = cue.endMs;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    start: first.start,
    end: last.end,
    startMs: first.startMs,
    endMs: last.endMs,
    durationMs: Math.max(0, last.endMs - first.startMs),
  };
}

function findFirstDivergentCue(expected, actual, toleranceMs = 25) {
  const max = Math.min(expected.length, actual.length);
  for (let i = 0; i < max; i += 1) {
    const e = expected[i];
    const a = actual[i];
    if (Math.abs(e.startMs - a.startMs) > toleranceMs || Math.abs(e.endMs - a.endMs) > toleranceMs) {
      return {
        index: i + 1,
        expected: `${e.start} --> ${e.end}`,
        actual: `${a.start} --> ${a.end}`,
      };
    }
  }
  return null;
}

function assertCueTimelineMatch(expectedFile, actualFile, label, opts = {}) {
  const requireEqualCueCount = opts.requireEqualCueCount !== false;
  const startToleranceMs = Math.max(0, Number(opts.startToleranceMs ?? 1500));
  const endToleranceMs = Math.max(0, Number(opts.endToleranceMs ?? 1500));
  const cueToleranceMs = Math.max(0, Number(opts.cueToleranceMs ?? 25));
  const expected = parseSrtCueRows(expectedFile);
  const actual = parseSrtCueRows(actualFile);
  if (!expected.length) {
    throw new Error(`[timing-contract] expected cues missing: ${expectedFile}`);
  }
  if (!actual.length) {
    throw new Error(`[timing-contract] actual cues missing: ${actualFile}`);
  }
  const expectedTimeline = summarizeCueTimeline(expected);
  const actualTimeline = summarizeCueTimeline(actual);
  const startDeltaMs = Math.abs(expectedTimeline.startMs - actualTimeline.startMs);
  const endDeltaMs = Math.abs(expectedTimeline.endMs - actualTimeline.endMs);
  const durationDeltaMs = Math.abs(expectedTimeline.durationMs - actualTimeline.durationMs);
  const maxDurationDeltaMs = Math.max(
    2000,
    Math.round(expectedTimeline.durationMs * 0.05),
    Math.round(Number(opts.maxDurationDeltaMs ?? 0)),
  );

  if (requireEqualCueCount) {
    if (expected.length !== actual.length) {
      throw new Error(
        `[timing-contract] ${label} cue-count mismatch: expected=${expected.length} actual=${actual.length} expected_file=${expectedFile} actual_file=${actualFile}`,
      );
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (
        Math.abs(expected[i].startMs - actual[i].startMs) > cueToleranceMs ||
        Math.abs(expected[i].endMs - actual[i].endMs) > cueToleranceMs
      ) {
        throw new Error(
          `[timing-contract] ${label} cue-${i + 1} mismatch: expected=${expected[i].start} --> ${expected[i].end} actual=${actual[i].start} --> ${actual[i].end} expected_file=${expectedFile} actual_file=${actualFile}`,
        );
      }
    }
    return { ok: true, warning: null };
  }

  if (startDeltaMs > startToleranceMs || endDeltaMs > endToleranceMs || durationDeltaMs > maxDurationDeltaMs) {
    const divergent = findFirstDivergentCue(expected, actual, cueToleranceMs);
    const divergentText = divergent
      ? ` first_divergent_cue=${divergent.index} expected=${divergent.expected} actual=${divergent.actual}`
      : "";
    throw new Error(
      `[timing-contract] ${label} timeline mismatch: expected_count=${expected.length} actual_count=${actual.length} expected_start=${expectedTimeline.start} actual_start=${actualTimeline.start} expected_end=${expectedTimeline.end} actual_end=${actualTimeline.end} start_delta_ms=${startDeltaMs} end_delta_ms=${endDeltaMs} duration_delta_ms=${durationDeltaMs} expected_file=${expectedFile} actual_file=${actualFile}${divergentText}`,
    );
  }

  if (expected.length !== actual.length) {
    const msg = `${label} cue-count differs but timeline coverage matches: expected=${expected.length} actual=${actual.length} expected_start=${expectedTimeline.start} actual_start=${actualTimeline.start} expected_end=${expectedTimeline.end} actual_end=${actualTimeline.end} duration_delta_ms=${durationDeltaMs} expected_file=${expectedFile} actual_file=${actualFile}`;
    return { ok: true, warning: msg };
  }

  return { ok: true, warning: null };
}
async function assertCanonicalSentenceTimingFromWordCues({
  transcriptDir,
  basePlain,
  baseTimingSrt,
  canonicalSentenceSrt,
  driftSeconds = 1.5,
}) {
  const probePath = path.join(
    transcriptDir,
    `.timing-contract-${process.pid}-${Date.now()}.probe.srt`,
  );
  try {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/lyrics_to_srt_from_timing.mjs"),
        basePlain,
        baseTimingSrt,
        probePath,
      ],
      cwd: ROOT,
      env: {
        PYA_SRT_MAX_DRIFT_SECONDS: String(driftSeconds),
      },
      timeoutMs: 20 * 60 * 1000,
      label: "timing-contract-canonical-from-word-cues",
    });
    assertCueTimelineMatch(probePath, canonicalSentenceSrt, "canonical-vs-word-cues");
  } finally {
    try { fs.unlinkSync(probePath); } catch {}
  }
}

function isValidWiseSeries(filePath) {
  if (!hasMinSize(filePath, 150)) return false;
  const text = safeReadText(filePath, "");
  return (
    /su name wise chips be series def/iu.test(text) &&
    /since num /iu.test(text) &&
    /\[Agenda Start\]/iu.test(text)
  );
}

function parsePyaJsonTextField(filePath, fieldName) {
  const values = readPyaTextValues(filePath, [fieldName]);
  const raw = String(values[fieldName] || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isValidAgendaGroundingPya(filePath) {
  if (!hasMinSize(filePath, 200)) return false;
  const grounded = parsePyaJsonTextField(filePath, "grounded units");
  if (!Array.isArray(grounded) || !grounded.length) return false;
  const values = readPyaTextValues(filePath, ["canonical source path"]);
  let canonicalPath = "";
  try { canonicalPath = JSON.parse(String(values["canonical source path"] || "")); } catch {}
  if (!canonicalPath || !fs.existsSync(canonicalPath)) return false;
  let canonical;
  try { canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8")); } catch { return false; }
  const canonicalItems = Array.isArray(canonical?.items) ? canonical.items : [];
  const first = grounded[0]?.["agenda item"];
  const firstItem = canonicalItems.find((item) => String(item?.item || "").toLowerCase() === String(first || "").toLowerCase());
  const hasSubstantiveAncestor = firstItem && String(firstItem.item).includes(".")
    && canonicalItems.some((item) => item?.attachments?.length
      && String(firstItem.item).startsWith(`${item.item}.`));
  // A reference-only child cannot be the sole publisher of a long chronology
  // when its structured attachment-backed parent owns the source material.
  // This rejects stale collapsed checkpoints so the repaired segmentation stage
  // is actually rerun after a prior failure.
  if (grounded.length === 1 && firstItem && !firstItem.attachments?.length && hasSubstantiveAncestor) return false;
  return grounded.every((unit) => unit?.["atomic start"] && unit?.["atomic end"] && unit?.["source excerpt"]);
}

function isValidAgendaMatchesPya(filePath, groundingFilePath = "") {
  if (!hasMinSize(filePath, 120)) return false;
  const values = readPyaTextValues(filePath, ["sections total"]);
  const sectionsTotal = Number(values["sections total"] || 0);
  const assignments = parsePyaJsonTextField(filePath, "assignments");
  return Number.isFinite(sectionsTotal) && sectionsTotal > 0 && Array.isArray(assignments) && assignments.length > 0
    && (!groundingFilePath || isValidAgendaGroundingPya(groundingFilePath));
}

function isValidAgendaSummaryPya(filePath) {
  if (!hasMinSize(filePath, 200)) return false;
  const sections = parsePyaJsonTextField(filePath, "sections");
  return Array.isArray(sections) && sections.length > 0;
}

function isValidMeetingSummaryMd(filePath) {
  if (!hasMinSize(filePath, 400)) return false;
  const text = safeReadText(filePath, "");
  return (
    /^#\s+Whole Meeting Summary\b/mu.test(text) &&
    /^##\s+Top Newsworthy Developments\b/mu.test(text) &&
    /^##\s+Why It Matters\b/mu.test(text) &&
    /^##\s+Watch Next\b/mu.test(text)
  );
}

function isValidMeetingSummaryChunksPya(filePath) {
  if (!hasMinSize(filePath, 180)) return false;
  const chunks = parsePyaJsonTextField(filePath, "chunks");
  if (!Array.isArray(chunks) || !chunks.length) return false;
  const total = Number(readPyaTextValues(filePath, ["source sections total"])["source sections total"] || 0);
  return Number.isFinite(total) && total > 0;
}

function isValidHookTxt(filePath) {
  if (!hasMinSize(filePath, 4)) return false;
  const line = safeReadText(filePath, "").trim();
  return isTranscriptKeywordHook(line);
}

function isTranscriptKeywordHook(hook = "") {
  const s = String(hook || "").replace(/\s+/gu, " ").trim();
  if (!s) return false;
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length < 3 || words.length > 6) return false;
  if (/[.!?,:;()[\]{}*_#`]/u.test(s)) return false;
  if (/^(the|a|an|the successful|a proposed|an? presentation|the presentation|the committee|the council|staff presented|staff proposed|council approved|council requested|motion to|speaker\s+\d+\b|representative voices?|resident voices?|residents voice)\b/iu.test(s)) return false;
  const normalized = s.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const genericHooks = new Set([
    "grey county meeting highlights",
    "county council meeting highlights",
    "committee meeting highlights",
    "meeting highlights",
  ]);
  return !genericHooks.has(normalized);
}

function isValidAgendaReferenceCorroborationPya(filePath) {
  if (!hasMinSize(filePath, 100)) return false;
  const values = readPyaTextValues(filePath, ["unresolved total"]);
  const unresolved = Number(values["unresolved total"] || Number.NaN);
  return Number.isFinite(unresolved) && unresolved <= 0;
}

function resolveReporterPath(inputPath) {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(HOUSE, inputPath);
}

const SECRET_VALUES = readPyaTextValues(SECRET_PATH, [
  "speaker host",
  "speaker host root",
  "ollama host",
  "ai host",
  "relay local host",
]);
const GLOBAL_DEFAULT_VALUES = readPyaTextValues(GLOBAL_DEFAULTS_PATH, [
  "speaker host",
  "speaker host root",
]);

function resolveSpeakerHost() {
  const fromEnv = String(process.env.PYA_SPEAKER_HOST || process.env.SPEAKER_HOST || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/u, "");
  const fromSecret = String(SECRET_VALUES["speaker host"] || "").trim();
  if (fromSecret) return fromSecret.replace(/\/$/u, "");
  const fromGlobal = String(GLOBAL_DEFAULT_VALUES["speaker host"] || "").trim();
  if (fromGlobal) return fromGlobal.replace(/\/$/u, "");
  return HARD_DEFAULT_SPEAKER_HOST;
}

function resolveSpeakerHostRoot() {
  const fromEnv = String(process.env.PYA_SPEAKER_HOST_ROOT || "").trim();
  if (fromEnv) return fromEnv;
  const fromSecret = String(SECRET_VALUES["speaker host root"] || "").trim();
  if (fromSecret) return fromSecret;
  const fromGlobal = String(GLOBAL_DEFAULT_VALUES["speaker host root"] || "").trim();
  if (fromGlobal) return fromGlobal;
  return HARD_DEFAULT_SPEAKER_HOST_ROOT;
}

function resolveOllamaHost() {
  const fromEnv = String(process.env.OLLAMA_HOST || "").trim();
  const fromPya = String(SECRET_VALUES["ollama host"] || SECRET_VALUES["ai host"] || SECRET_VALUES["relay local host"] || "").trim();
  return requireRemoteOllamaHost(fromEnv || fromPya || "http://mriczo:11434", {
    label: "Grey County Ollama host",
  });
}

export function resolveHearQwenHost({ env = process.env, cwd = HOUSE } = {}) {
  const explicit = String(env?.PYA_HEAR_QWEN_HOST || env?.PYA_DRAW_HOST || "").trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  const configured = resolveConfiguredText("hear qwen host", { cwd })
    || resolveConfiguredText("draw host", { cwd });
  return String(configured || "").trim().replace(/\/+$/u, "");
}

function runWithStreaming({ cmd, args, cwd = ROOT, env = {}, timeoutMs = 30 * 60 * 1000, label = "stage" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk ?? "");
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk ?? "");
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Math.max(10_000, Number(timeoutMs) || 10_000));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const msg = `${label} failed (code=${code ?? "null"} signal=${signal ?? ""})`;
      reject(new Error(`${msg}\n${stderr || stdout}`.trim()));
    });
  });
}

async function runSubmitHook(command, payloadPath) {
  const escapedPayload = String(payloadPath).replace(/"/gu, "\\\"");
  await runWithStreaming({
    cmd: "bash",
    args: ["-lc", `${command} "${escapedPayload}"`],
    cwd: ROOT,
    timeoutMs: 10 * 60 * 1000,
    label: "submit-hook",
  });
}

function ffprobeDurationSeconds(audioPath) {
  return new Promise((resolve) => {
    if (!existsFile(audioPath)) return resolve(0);
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk ?? ""); });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const n = Number(String(out || "").trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

function scaleTimeout(baseMs, audioSeconds, slopePerHour = 0.8) {
  const hours = Math.max(0, Number(audioSeconds) || 0) / 3600;
  const factor = 1 + (hours * slopePerHour);
  return Math.round(baseMs * Math.max(1, factor));
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "unknown";
}

function deriveDateLongFromMeetingDir(meetingDirName) {
  const m = String(meetingDirName || "").match(/^(\d{4})-(\d{2})-(\d{2})/u);
  if (!m) return { iso: "", long: "Unknown date" };
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  return {
    iso,
    long: dt.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }),
  };
}

function safeReadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeReadText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export function normalizeGeneratedOneSentence(value = "") {
  return String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function generateOneSentenceSummaryLlm({ summaryMd = "", hookTitle = "", jurisdiction = "", body = "", dateLong = "" }) {
  const source = String(summaryMd || "").trim();
  if (!source) throw new Error("one-sentence summary source is empty");
  const ollamaBase = resolveOllamaHost().replace(/\/+$/u, "");
  const basePrompt = [
    "Write exactly one sentence describing the complete civic meeting transcript.",
    "Use only facts supported by SOURCE; do not infer an outcome or omit the meeting's substantive scope.",
    "Return only the sentence, with no heading, bullets, quotation marks, or explanation.",
    `Keep it between ${MEETING_ONE_SENTENCE_MIN_WORDS} and ${MEETING_ONE_SENTENCE_MAX_WORDS} words, use plain factual language, and end with exactly one period.`,
    hookTitle ? `Generated meeting hook for context: ${hookTitle}` : "",
    `Meeting context: ${jurisdiction} ${body}, ${dateLong}.`,
    "",
    `SOURCE:\n${source.slice(0, 18_000)}`,
  ].filter(Boolean).join("\n");
  let lastError = "";
  let rejectedCandidate = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const retryPrompt = attempt === 1
      ? basePrompt
      : [
        basePrompt,
        "",
        `RETRY ${attempt}: produce a fresh answer that satisfies the complete one-sentence contract.`,
        `REJECTION_REASON: ${lastError || "The previous response did not satisfy the output contract."}`,
        attempt >= 3
          ? "Fresh repair contract: write from SOURCE only; do not revise, quote, or repeat the rejected sentence."
          : `PRIOR_REJECTED_CANDIDATE: ${rejectedCandidate.slice(0, 800)}`,
        `Return only one complete sentence of ${MEETING_ONE_SENTENCE_MIN_WORDS}-${MEETING_ONE_SENTENCE_MAX_WORDS} words, ending with one period.`,
      ].join("\n");
    let candidate = "";
    try {
      const json = await requestManagedOllamaChat({
        ollamaUrl: ollamaBase,
        managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
        keepAlive: 300,
        think: false,
        options: { num_predict: 128, temperature: attempt === 1 ? 0.15 : 0.35 },
        messages: [
          { role: "system", content: "You write concise factual civic meeting summaries." },
          { role: "user", content: retryPrompt },
        ],
        timeoutMs: 300000,
      });
      candidate = normalizeGeneratedOneSentence(json?.message?.content || json?.response || "");
      const sentenceCount = (candidate.match(/[.!?](?:\s|$)/gu) || []).length;
      const wordCount = candidate.split(/\s+/u).filter(Boolean).length;
      if (!candidate) throw new Error("qwen returned empty content");
      if (
        sentenceCount !== 1
        || wordCount < MEETING_ONE_SENTENCE_MIN_WORDS
        || wordCount > MEETING_ONE_SENTENCE_MAX_WORDS
      ) {
        throw new Error(`qwen returned an invalid one-sentence shape (${wordCount} words, ${sentenceCount} sentence endings)`);
      }
      return candidate;
    } catch (error) {
      if (candidate) rejectedCandidate = candidate;
      lastError = String(error?.message || error);
    }
  }
  throw new Error(`one-sentence summary generation failed; job remains retryable: ${lastError || "unknown qwen error"}`);
}

function syncSpeakerArtifactsToGlobal({ fromDir, toDir }) {
  if (!existsFile(path.join(fromDir, "index.pya"))) return { copied: 0, keys: [] };
  fs.mkdirSync(toDir, { recursive: true });
  const copiedKeys = [];
  const names = fs.readdirSync(fromDir)
    .filter((n) => /^speaker_\d+\.pya$/iu.test(n))
    .map((n) => n.replace(/\.pya$/u, ""))
    .sort();
  for (const key of names) {
    let copiedForKey = false;
    for (const ext of [".pya", ".npy", ".wav"]) {
      const src = path.join(fromDir, `${key}${ext}`);
      const dst = path.join(toDir, `${key}${ext}`);
      if (!existsFile(src)) continue;
      if (!existsFile(dst)) {
        fs.copyFileSync(src, dst);
        copiedForKey = true;
      }
    }
    if (copiedForKey) copiedKeys.push(key);
  }
  return { copied: copiedKeys.length, keys: copiedKeys };
}

function hasSuccessfulMeetingPublishResponse(transcriptDir) {
  if (!existsDir(transcriptDir)) return false;
  const files = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith(".meeting-publish.response.json"));
  for (const name of files) {
    const full = path.join(transcriptDir, name);
    try {
      const obj = JSON.parse(fs.readFileSync(full, "utf8"));
      const postUrl = String(obj?.post_url || "").trim();
      const transcriptUrl = String(obj?.transcript_url || "").trim();
      const err = String(obj?.error || "").trim();
      if ((postUrl || transcriptUrl) && !err) return true;
    } catch {
      // ignore malformed response artifacts
    }
  }
  return false;
}

async function main() {
  if (!process.env.PYA_RUNTIME_FILE) process.env.PYA_RUNTIME_FILE = path.join(HOUSE, "conduct", "runtime.pya");
  const transcriptDirArg = process.argv[2];
  const basePrefix = process.argv[3] || "meeting-qwen-auto";
  const focus = process.argv[4] || DEFAULT_FOCUS;
  const jurisdiction = process.argv[5] || "Grey County";
  const body = process.argv[6] || "County Council";
  const siteUrl = process.argv[7] || DEFAULT_SITE;
  const discussionUrl = process.argv[8] || "";

  if (!transcriptDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const transcriptDir = resolveReporterPath(transcriptDirArg);
  ensureDir(transcriptDir);
  const meetingDir = path.dirname(transcriptDir);

  const baseVoicesDir = process.env.GREY_VOICES_DIR || path.join(ROOT, "world/voices");
  const requestedVoicesWorkDir = process.env.GREY_VOICES_WORK_DIR || path.join(transcriptDir, "voices-working");
  const isolateVoices = !/^(0|false|no)$/iu.test(String(process.env.PYA_SPEAKER_ISOLATE_VOICES || "0"));
  let voicesWorkDir = requestedVoicesWorkDir;
  try {
    ensureWritableDir(voicesWorkDir);
  } catch {
    const fallback = path.join(os.tmpdir(), "grey-voices-working", path.basename(meetingDir));
    ensureWritableDir(fallback);
    voicesWorkDir = fallback;
    log(`[full-pipeline] warn voices-working not writable: ${requestedVoicesWorkDir}`);
    log(`[full-pipeline] using fallback voices-working: ${voicesWorkDir}`);
  }

  const artifacts = buildGreyTranscriptArtifacts({ transcriptDir, basePrefix });
  const normPrefix = artifacts.normalized_prefix;
  const activeVoicesDir = isolateVoices ? voicesWorkDir : baseVoicesDir;
  const namedSpeakerIdentity = namedSpeakerIdentityEnabled(process.env);
  const force = /^(1|true|yes)$/iu.test(String(process.env.GREY_PIPELINE_FORCE || ""));
  const forceWholeMeetingSummary = /^(1|true|yes)$/iu.test(
    String(process.env.GREY_PIPELINE_FORCE_WHOLE_SUMMARY || ""),
  );
  const skipImage = /^(1|true|yes)$/iu.test(String(process.env.GREY_PIPELINE_SKIP_IMAGE || ""));
  const skipLemmy =
    /^(1|true|yes)$/iu.test(String(process.env.GREY_PIPELINE_SKIP_LEMMY || "")) ||
    /^(1|true|yes)$/iu.test(String(process.env.PIPELINE_SKIP_POST || ""));
  const forcePostStage =
    /^(1|true|yes)$/iu.test(String(process.env.GREY_PIPELINE_FORCE_POST || "")) ||
    /^(1|true|yes)$/iu.test(String(process.env.PIPELINE_FORCE_POST || ""));

  const baseTimingSrt = artifacts.base_timing_srt;
  const basePlain = artifacts.base_plain_txt;
  const baseMerged = artifacts.base_merged_srt;

  const normalizedPlain = artifacts.normalized_plain_txt;
  const normalizedMeta = artifacts.normalized_meta_json;
  const normalizedSentenceMerged = artifacts.normalized_sentence_merged_srt;
  const timedSentenceMerged = path.join(transcriptDir, `${basePrefix}.sentences.merged.srt`);
  const speakerJson = artifacts.speaker_json;
  const speakerSrt = artifacts.speaker_srt;
  const autoAssignReport = artifacts.autoassign_report_json;
  const agendaWiseSeries = artifacts.agenda_wise_series_pya;
  const agendaGrossChunksPya = artifacts.agenda_gross_chunks_pya;
  const agendaMatchesPya = artifacts.agenda_matches_pya;
  const agendaSectionGroundingPya = artifacts.agenda_section_grounding_pya;
  const agendaSummaryPya = artifacts.agenda_summary_pya;
  const agendaReferenceCorroborationPya = path.join(transcriptDir, `${normPrefix}.agenda-reference-corroboration.pya`);
  const meetingSummaryChunksPya = artifacts.meeting_summary_chunks_pya;
  const meetingSummaryPya = artifacts.meeting_summary_pya;
  const meetingSummaryMd = artifacts.meeting_summary_md;
  const meetingHookTxt = artifacts.meeting_hook_txt;
  const htmlPath = artifacts.transcript_html;
  const coverImagePath = artifacts.cover_image;
  const coverImageStablePath = artifacts.cover_image_stable;
  const lemmyPayloadPath = artifacts.lemmy_payload_json;
  const lemmyBodyPath = artifacts.lemmy_post_md;
  const articleClaimsVerifyPath = path.join(transcriptDir, `${normPrefix}.article-claims.verify.pya`);

  const rosterPath = process.env.GREY_ROSTER_FILE || path.join(HOUSE, "artifacts/grey-county/roster.txt");
  const speakerHost = resolveSpeakerHost();
  const speakerHostRoot = resolveSpeakerHostRoot();
  const ollamaHost = resolveOllamaHost();
  if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = ollamaHost;
  const gpuHousekeeper = resolveGpuHousekeeperUrl({
    ollamaUrl: ollamaHost,
    env: process.env,
  });
  if (!process.env.PYA_GPU_HOUSEKEEPER_URL) process.env.PYA_GPU_HOUSEKEEPER_URL = gpuHousekeeper;
  if (!gpuHousekeeper) throw new Error("Grey County pipeline requires the configured GPU housekeeper endpoint");
  process.env.PYA_GPU_MANAGER_REQUIRED = "1";
  process.env.PYA_GPU_MANAGER_ALLOW_DIRECT = "0";
  const hearQwenHost = resolveHearQwenHost({ env: process.env, cwd: HOUSE });
  if (!process.env.PYA_HEAR_QWEN_HOST && hearQwenHost) process.env.PYA_HEAR_QWEN_HOST = hearQwenHost;
  log(`[llm] ollama host: ${ollamaHost}`);
  log(`[gpu] housekeeper: ${gpuHousekeeper}`);
  log(`[gpu] hear provider: ${hearQwenHost || process.env.PYA_HEAR_QWEN_HOST || process.env.PYA_DRAW_HOST || "unconfigured"}`);

  const audioPath = path.join(transcriptDir, "meeting-audio.opus");
  const audioSeconds = await ffprobeDurationSeconds(audioPath);
  log(`[full-pipeline] transcript dir: ${transcriptDir}`);
  log(`[full-pipeline] base prefix: ${basePrefix}`);
  log(`[full-pipeline] normalized prefix: ${normPrefix}`);
  log(`[full-pipeline] audio seconds: ${audioSeconds.toFixed(1)}`);

  const stageStatus = [];
  let qualityVerifier = {
    checks: {},
    issues: [],
    summary: { has_error: false, has_warn: false, issue_count: 0 },
  };
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const meetingId = String(loadJsonArtifact(path.join(meetingDir, "meeting.json"), {})?.payload?.meeting_id || "").trim();
  const stageRunner = createStageRunner({
    log,
    force,
    writer: GREY_ADAPTER.writer_id,
    source: GREY_ADAPTER.source_id,
    meetingId,
    runId,
  });

  function speakerCheckpointValid() {
    if (!existsFile(speakerJson) || !existsFile(speakerSrt)) return false;
    if (!namedSpeakerIdentity
      && (!speakerArtifactUsesDefaultLabels(speakerJson) || !speakerArtifactUsesDefaultLabels(speakerSrt))) return false;
    const expected = countSrtCues(normalizedSentenceMerged);
    if (expected <= 0) return true;
    const rows = countSpeakerRowsJson(speakerJson);
    const srtCues = countSrtCues(speakerSrt);
    const minNeeded = Math.max(40, Math.floor(expected * 0.8));
    if (rows < minNeeded || srtCues < minNeeded) return false;
    try {
      summarizeCueTimeline(parseSrtCueRows(speakerSrt));
    } catch {
      return false;
    }
    return true;
  }

  function relabelCheckpointValid() {
    if (!namedSpeakerIdentity) return true;
    if (!existsFile(speakerJson) || !existsFile(speakerSrt)) return false;
    const srtTime = fileMtimeMs(speakerSrt);
    const jsonTime = fileMtimeMs(speakerJson);
    const reportTime = fileMtimeMs(autoAssignReport);
    return srtTime >= jsonTime && srtTime >= reportTime;
  }

  function agendaSummaryCheckpointValid() {
    if (!isValidAgendaSummaryPya(agendaSummaryPya)) return false;
    const summaryTime = fileMtimeMs(agendaSummaryPya);
    const groundingTime = fileMtimeMs(agendaSectionGroundingPya);
    return !(groundingTime > 0 && summaryTime < groundingTime);
  }

  function wholeMeetingSummaryCheckpointValid() {
    if (!isValidMeetingSummaryMd(meetingSummaryMd) || !isValidMeetingSummaryChunksPya(meetingSummaryChunksPya)) return false;
    const summaryTime = fileMtimeMs(meetingSummaryMd);
    const agendaTime = fileMtimeMs(agendaSummaryPya);
    const chunksTime = fileMtimeMs(meetingSummaryChunksPya);
    if (agendaTime > 0 && summaryTime < agendaTime) return false;
    if (chunksTime > 0 && summaryTime < chunksTime) return false;
    return true;
  }

  function normalizeCheckpointValid() {
    if (!existsFile(normalizedPlain) || !existsFile(normalizedMeta)) return false;
    const normalizedText = safeReadText(normalizedPlain, '').trim();
    if (!normalizedText) return false;
    // Reuse successful normalized artifacts when available, even if a fresh
    // normalize attempt fails due transient model/network issues.
    return true;
  }

  function freshCoverImagePath() {
    const imagePath = existsFile(coverImageStablePath) ? coverImageStablePath : (existsFile(coverImagePath) ? coverImagePath : "");
    if (!imagePath) return "";
    const imageTime = fileMtimeMs(imagePath);
    const upstreamTime = Math.max(fileMtimeMs(meetingSummaryMd), fileMtimeMs(meetingHookTxt));
    if (upstreamTime > 0 && imageTime < upstreamTime) return "";
    return imagePath;
  }

  function imageCheckpointValid() {
    return Boolean(freshCoverImagePath());
  }

  async function stage(name, fn, opts = {}) {
    const record = await stageRunner.runStage(name, fn, opts);
    const legacy = { stage: name, status: record.status };
    if (record.duration_ms > 0) legacy.duration_ms = record.duration_ms;
    if (record.status === "warn" && record.error) legacy.error = record.error;
    stageStatus.push(legacy);
  }

  await stage("transcribe+merge", async () => {
    const hearTimeoutMs = Number(
      process.env.PYA_HEAR_TIMEOUT_MS
      || process.env.PYA_HEAR_QWEN_TIMEOUT_MS
      || scaleTimeout(95 * 60 * 1000, audioSeconds, 1.0),
    );
    const hearAttempts = Number(process.env.QWEN_HEAR_STAGE_ATTEMPTS || "2") || 2;
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(HOUSE, "program/transcribe-and-merge-qwen-from-transcript-folder.mjs"),
        transcriptDir,
        basePrefix,
      ],
      cwd: ROOT,
      env: {
        PYA_HEAR_TIMEOUT_MS: String(hearTimeoutMs),
        QWEN_HEAR_STAGE_ATTEMPTS: String(hearAttempts),
      },
      timeoutMs: Math.max(scaleTimeout(70 * 60 * 1000, audioSeconds, 1.8), (hearTimeoutMs * hearAttempts) + (20 * 60 * 1000)),
      label: "transcribe+merge",
    });
  }, {
    skipWhen: () => existsFile(baseMerged) && existsFile(baseTimingSrt) && existsFile(basePlain),
    inputArtifacts: [audioPath],
    outputArtifacts: [baseMerged, baseTimingSrt, basePlain],
  });

  await stage("normalize-transcript", async () => {
    try {
      await runWithStreaming({
        cmd: "node",
        args: [
          path.join(HOUSE, "program/normalize-transcript-from-transcript-folder.mjs"),
          transcriptDir,
          basePrefix,
          normPrefix,
        ],
        cwd: ROOT,
        env: {
          ...(ollamaHost ? { OLLAMA_HOST: ollamaHost } : {}),
        },
        timeoutMs: scaleTimeout(40 * 60 * 1000, audioSeconds, 1.1),
        label: "normalize-transcript",
      });
    } catch (err) {
      if (normalizeCheckpointValid()) {
        log(`[full-pipeline] warn normalize-transcript failed; using checkpoint artifacts (${String(err?.message || err)})`);
        return;
      }
      throw err;
    }
  }, {
    skipWhen: () => normalizeCheckpointValid(),
    inputArtifacts: [basePlain, baseTimingSrt],
    outputArtifacts: [normalizedPlain, normalizedMeta],
  });

  await stage("merge-normalized-sentence-srt", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/lyrics_to_srt_from_timing.mjs"),
        basePlain,
        baseTimingSrt,
        timedSentenceMerged,
      ],
      cwd: ROOT,
      timeoutMs: 5 * 60 * 1000,
      label: "merge-normalized-sentence-srt",
    });
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(HOUSE, "program/apply_string_replacement_map_to_srt.mjs"),
        timedSentenceMerged,
        normalizedMeta,
        normalizedSentenceMerged,
      ],
      cwd: ROOT,
      timeoutMs: 5 * 60 * 1000,
      label: "apply-normalize-replacements-to-sentence-srt",
    });
    assertCueTimelineMatch(timedSentenceMerged, normalizedSentenceMerged, "normalize-text-only");
  }, {
    skipWhen: () => existsFile(normalizedSentenceMerged),
    inputArtifacts: [baseTimingSrt, normalizedMeta],
    outputArtifacts: [timedSentenceMerged, normalizedSentenceMerged],
  });

  await stage("verify-sentence-timing-contract", async () => {
    await assertCanonicalSentenceTimingFromWordCues({
      transcriptDir,
      basePlain,
      baseTimingSrt,
      canonicalSentenceSrt: timedSentenceMerged,
      driftSeconds: Number(process.env.PYA_SRT_MAX_DRIFT_SECONDS || 1.5),
    });
    assertCueTimelineMatch(timedSentenceMerged, normalizedSentenceMerged, "normalized-vs-canonical", { requireEqualCueCount: true });
  });

  await stage("diarize-speakers", async () => {
    const sharedEnv = buildSentenceDiarizationEnv({
      PYA_SPEAKER_ISOLATE_VOICES: isolateVoices ? "1" : "0",
      PYA_SPEAKER_RESEED_VOICES: process.env.PYA_SPEAKER_RESEED_VOICES || "0",
      ...(speakerHost ? { PYA_SPEAKER_HOST: speakerHost } : {}),
      ...(speakerHostRoot ? { PYA_SPEAKER_HOST_ROOT: speakerHostRoot } : {}),
    }, process.env);
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/diarize_sentence_srt_from_transcript_folder.mjs"),
        transcriptDir,
        `${normPrefix}.sentences`,
        baseVoicesDir,
      ],
      cwd: ROOT,
      env: sharedEnv,
      timeoutMs: scaleTimeout(70 * 60 * 1000, audioSeconds, 1.4),
      label: "diarize-speakers",
    });
  }, {
    skipWhen: () => speakerCheckpointValid(),
    inputArtifacts: [normalizedSentenceMerged],
    outputArtifacts: [speakerJson, speakerSrt],
  });

  await stage("auto-assign-speakers-from-callouts", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/auto_assign_speakers_from_callouts.mjs"),
        transcriptDir,
        `${normPrefix}.sentences`,
        rosterPath,
        activeVoicesDir,
      ],
      cwd: ROOT,
      env: {
        PYA_SPEAKER_NAME_LINKING: namedSpeakerIdentity ? "1" : "0",
        PYA_AUTOASSIGN_OVERWRITE_EXISTING: "0",
      },
      timeoutMs: 10 * 60 * 1000,
      label: "auto-assign-speakers-from-callouts",
    });
  }, {
    optional: true,
    skipWhen: () => !namedSpeakerIdentity,
    inputArtifacts: [speakerJson, rosterPath],
    outputArtifacts: [autoAssignReport],
  });

  await stage("relabel-speakers", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/relabel_speaker_sentence_srt_from_transcript_folder.mjs"),
        transcriptDir,
        `${normPrefix}.sentences`,
        activeVoicesDir,
      ],
      cwd: ROOT,
      env: {
        PYA_SPEAKER_NAME_LINKING: namedSpeakerIdentity ? "1" : "0",
      },
      timeoutMs: 10 * 60 * 1000,
      label: "relabel-speakers",
    });
  }, {
    skipWhen: () => !namedSpeakerIdentity || relabelCheckpointValid(),
    inputArtifacts: [speakerJson, autoAssignReport],
    outputArtifacts: [speakerSrt, speakerJson],
  });

  await stage("verify-speaker-timing-contract", async () => {
    const strictSpeakerTiming = !/^(0|false|no)$/iu.test(String(process.env.PYA_VERIFY_SPEAKER_TIMING_CONTRACT || "1"));
    if (!strictSpeakerTiming) return;
    const result = assertCueTimelineMatch(normalizedSentenceMerged, speakerSrt, "speaker-vs-normalized", {
      requireEqualCueCount: false,
      startToleranceMs: 1500,
      endToleranceMs: 1500,
      cueToleranceMs: 40,
    });
    if (result?.warning) {
      log(`[timing-contract] warn ${result.warning}`);
      return {
        validation_flags: {
          speaker_timing_count_mismatch: true,
        },
        notes: result.warning,
      };
    }
    return {
      validation_flags: {
        speaker_timing_count_mismatch: false,
      },
    };
  }, {
    inputArtifacts: [normalizedSentenceMerged, speakerSrt],
    outputArtifacts: [speakerSrt],
  });

  await stage("sync-speaker-artifacts-to-global-voices", async () => {
    if (!isolateVoices || voicesWorkDir === baseVoicesDir) {
      log("[full-pipeline] speaker artifacts copied: 0 (isolate voices off)");
      return;
    }
    const result = syncSpeakerArtifactsToGlobal({ fromDir: voicesWorkDir, toDir: baseVoicesDir });
    log(`[full-pipeline] speaker artifacts copied: ${result.copied}`);
  }, {
    optional: true,
    outputArtifacts: [baseVoicesDir],
  });

  await stage("agenda-aware-wise-chunks", async () => {
    try {
      await runWithStreaming({
        cmd: "node",
        args: [
          path.join(HOUSE, "program/wise-chunk-grey-county-agenda-aware-from-transcript-folder.mjs"),
          transcriptDir,
          normPrefix,
        ],
        cwd: ROOT,
        env: {
          ...(ollamaHost ? { OLLAMA_HOST: ollamaHost } : {}),
          GREY_AGENDA_USE_LLM_RANGE: process.env.GREY_AGENDA_USE_LLM_RANGE || "1",
          AGENDA_MAX_GAP_ROWS: process.env.AGENDA_MAX_GAP_ROWS || "12",
        },
        timeoutMs: scaleTimeout(50 * 60 * 1000, audioSeconds, 0.7),
        label: "agenda-aware-wise-chunks",
      });
    } catch (err) {
      const hasCheckpoint = existsFile(agendaGrossChunksPya) && existsFile(agendaMatchesPya) && existsFile(agendaSectionGroundingPya) && isValidWiseSeries(agendaWiseSeries) && isValidAgendaMatchesPya(agendaMatchesPya, agendaSectionGroundingPya);
      if (hasCheckpoint) {
        log('[full-pipeline] warn agenda-aware-wise-chunks failed; using checkpoint artifacts (' + String(err?.message || err) + ')');
        return;
      }
      throw err;
    }
  }, {
    skipWhen: () => existsFile(agendaGrossChunksPya) && existsFile(agendaMatchesPya) && existsFile(agendaSectionGroundingPya) && isValidWiseSeries(agendaWiseSeries) && isValidAgendaMatchesPya(agendaMatchesPya, agendaSectionGroundingPya),
    inputArtifacts: [speakerSrt],
    outputArtifacts: [agendaGrossChunksPya, agendaMatchesPya, agendaSectionGroundingPya, agendaWiseSeries],
  });

  await stage("agenda-section-summaries", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(HOUSE, "program/summarize-agenda-wise-sections-from-transcript-folder.mjs"),
        transcriptDir,
        normPrefix,
        focus,
      ],
      cwd: ROOT,
      env: {
        ...(ollamaHost ? { OLLAMA_HOST: ollamaHost } : {}),
      },
      timeoutMs: scaleTimeout(75 * 60 * 1000, audioSeconds, 0.9),
      label: "agenda-section-summaries",
    });
  }, {
    skipWhen: () => agendaSummaryCheckpointValid(),
    inputArtifacts: [agendaSectionGroundingPya],
    outputArtifacts: [agendaSummaryPya],
  });

  await stage("agenda-reference-corroboration", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/corroborate_agenda_references_from_transcript_folder.mjs"),
        transcriptDir,
        normPrefix,
      ],
      cwd: ROOT,
      timeoutMs: 10 * 60 * 1000,
      label: "agenda-reference-corroboration",
    });
  }, {
    skipWhen: () => {
      if (!(existsFile(agendaReferenceCorroborationPya) && isValidAgendaReferenceCorroborationPya(agendaReferenceCorroborationPya))) return false;
      const reportTime = fileMtimeMs(agendaReferenceCorroborationPya);
      const upstream = Math.max(fileMtimeMs(agendaSummaryPya), fileMtimeMs(agendaWiseSeries));
      return !(upstream > 0 && reportTime < upstream);
    },
    inputArtifacts: [agendaSummaryPya, agendaWiseSeries],
    outputArtifacts: [agendaReferenceCorroborationPya],
  });

  await stage("whole-meeting-summary", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(HOUSE, "program/summarize-whole-meeting-from-agenda-summary.mjs"),
        transcriptDir,
        normPrefix,
        focus,
      ],
      cwd: ROOT,
      env: {
        ...(ollamaHost ? { OLLAMA_HOST: ollamaHost } : {}),
      },
      timeoutMs: 35 * 60 * 1000,
      label: "whole-meeting-summary",
    });
  }, {
    skipWhen: () => !forceWholeMeetingSummary && wholeMeetingSummaryCheckpointValid(),
    inputArtifacts: [agendaSummaryPya],
    outputArtifacts: [meetingSummaryChunksPya, meetingSummaryPya, meetingSummaryMd],
  });

  await stage("meeting-hook", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/generate_meeting_hook_from_transcript_folder.mjs"),
        transcriptDir,
        normPrefix,
        focus,
        jurisdiction,
        body,
      ],
      cwd: ROOT,
      env: {
        ...(ollamaHost ? { OLLAMA_HOST: ollamaHost } : {}),
      },
      timeoutMs: 15 * 60 * 1000,
      label: "meeting-hook",
    });
  }, {
    skipWhen: () => {
      if (!isValidHookTxt(meetingHookTxt)) return false;
      const hookTime = fileMtimeMs(meetingHookTxt);
      const summaryTime = fileMtimeMs(meetingSummaryMd);
      return !(summaryTime > 0 && hookTime < summaryTime);
    },
    inputArtifacts: [meetingSummaryMd],
    outputArtifacts: [meetingHookTxt],
  });

  await stage("quality-verifiers", async () => {
    const mode = String(process.env.AGENDA_SUMMARY_TIME_MODE || "standard").trim().toLowerCase();
    qualityVerifier = runQualityVerifiers({
      meetingSummaryMdPath: meetingSummaryMd,
      agendaSummaryPyaPath: agendaSummaryPya,
      mode,
      writer: GREY_ADAPTER.writer_id,
      source: GREY_ADAPTER.source_id,
      jurisdiction,
      body,
    });
    const notes = (qualityVerifier.issues || [])
      .map((x) => `[${x.level}] ${x.check}:${x.code}${x.detail ? ` ${x.detail}` : ""}`)
      .join(" | ");
    return {
      validation_flags: {
        required_sections_ok: Boolean(qualityVerifier?.checks?.required_sections?.ok),
        truncation_ok: Boolean(qualityVerifier?.checks?.truncation?.ok),
        tense_ok: Boolean(qualityVerifier?.checks?.tense?.ok),
        identity_scoping_ok: Boolean(qualityVerifier?.checks?.identity_scoping?.ok),
        verifier_has_error: Boolean(qualityVerifier?.summary?.has_error),
        verifier_has_warn: Boolean(qualityVerifier?.summary?.has_warn),
      },
      notes,
    };
  }, {
    inputArtifacts: [agendaSummaryPya, meetingSummaryMd],
    outputArtifacts: [agendaSummaryPya, meetingSummaryMd],
  });

  const meetingJsonPath = path.join(meetingDir, "meeting.json");
  const meetingPayload = safeReadJson(meetingJsonPath, {})?.payload || {};
  const meetingDateInfo = deriveDateLongFromMeetingDir(path.basename(meetingDir));
  const agendaPageUrl = `${siteUrl.replace(/\/+$/u, "")}/agendas/${slugify(jurisdiction)}/${canonicalMeetingRouteSlug(body)}/${meetingDateInfo.iso || "unknown-date"}`;
  const meetingUrl = String(meetingPayload?.meeting_url || "").trim();
  const payloadVideoDirect = Array.isArray(meetingPayload?.video_direct)
    ? meetingPayload.video_direct.find((x) => /^https?:\/\//iu.test(String(x || "")))
    : "";
  const payloadVideo = Array.isArray(meetingPayload?.video)
    ? meetingPayload.video.find((x) => /^https?:\/\//iu.test(String(x || "")))
    : "";
  const preferredVideo = String(payloadVideoDirect || payloadVideo || "");

  const hook = safeReadText(meetingHookTxt, "").trim();

  await stage("render-html", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/render_transcript_html_from_transcript_folder.mjs"),
        transcriptDir,
        htmlPath,
        jurisdiction,
        body,
        siteUrl,
        discussionUrl,
        meetingUrl,
        preferredVideo,
        hook,
        agendaPageUrl,
      ],
      cwd: ROOT,
      timeoutMs: 10 * 60 * 1000,
      label: "render-html",
    });
  }, {
    inputArtifacts: [speakerSrt, meetingHookTxt],
    outputArtifacts: [htmlPath],
  });

  await stage("draw-meeting-image", async () => {
    await runWithStreaming({
      cmd: "node",
      args: [
        path.join(ROOT, "command/draw_meeting_cover_from_transcript_folder.mjs"),
        transcriptDir,
        normPrefix,
        process.env.GREY_DRAW_STYLE || "",
      ],
      cwd: ROOT,
      env: {
        COVER_REQUIRE_SOURCE_VIDEO: "1",
        COVER_JURISDICTION: jurisdiction,
        COVER_MEETING_TYPE: body || "county council meeting",
        COVER_PROMPT_PROFILE: process.env.COVER_PROMPT_PROFILE || "teaching_video_scene",
      },
      timeoutMs: 45 * 60 * 1000,
      label: "draw-meeting-image",
    });
  }, {
    skipWhen: () => skipImage || imageCheckpointValid(),
    inputArtifacts: [meetingSummaryMd, meetingHookTxt],
    outputArtifacts: [coverImagePath, coverImageStablePath],
  });

  let publishStatus = {
    mode: "skip",
    command_source_env: "",
    dry_run: false,
    community_name: "",
  };

  await stage("lemmy-payload", async () => {
    const summaryMd = safeReadText(meetingSummaryMd, "").trim();
    const localCoverImage = freshCoverImagePath();
    const dateInfo = deriveDateLongFromMeetingDir(path.basename(meetingDir));
    const dateLong = dateInfo.long;
    const hookTitle = hook;
    if (!isTranscriptKeywordHook(hookTitle)) {
      throw new Error(`bad_heading_artifact: invalid_or_missing_keyword_hook hook="${hookTitle}"`);
    }
    const title = `${hookTitle} — ${jurisdiction} ${body} Transcript — ${dateLong}`;
    const oneSentenceSummary = await generateOneSentenceSummaryLlm({
      summaryMd,
      hookTitle,
      jurisdiction,
      body,
      dateLong,
    });

    const canonicalUrl = `${siteUrl.replace(/\/+$/u, "")}/transcripts/${slugify(jurisdiction)}/${slugify(body)}/${dateInfo.iso || "unknown-date"}`;
    const sourceLinks = [];
    if (meetingUrl) sourceLinks.push(`Official meeting page: ${meetingUrl}`);
    if (preferredVideo) sourceLinks.push(`Original video: ${preferredVideo}`);

    const bodyLines = [];
    if (oneSentenceSummary) bodyLines.push(`**One-Sentence Summary:** ${oneSentenceSummary}`);
    if (summaryMd) bodyLines.push(summaryMd);
    bodyLines.push(`Read full transcript: ${canonicalUrl}`);
    bodyLines.push(`Agenda page: ${agendaPageUrl}`);
    if (sourceLinks.length) bodyLines.push(sourceLinks.join("\n"));
    if (discussionUrl) bodyLines.push(`HelpOS discussion: ${discussionUrl}`);

    const bodyMd = bodyLines.join("\n\n").trim();

    const payload = {
      title,
      body_markdown: bodyMd,
      transcript_url: canonicalUrl,
      local_transcript_html: htmlPath,
      local_cover_image: localCoverImage,
      local_attachment_index: path.join(meetingDir, "converted", "subreports.index.json"),
      jurisdiction,
      body,
      date_iso: dateInfo.iso,
      hook: hookTitle,
      one_sentence_summary: oneSentenceSummary,
      focus,
      source: {
        meeting_url: meetingUrl || "",
        video_url: preferredVideo,
        agenda_url: agendaPageUrl,
      },
      discussion_url: discussionUrl || "",
      generated_at_utc: new Date().toISOString(),
    };

    fs.writeFileSync(lemmyPayloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.writeFileSync(lemmyBodyPath, `${bodyMd}\n`, "utf8");
    log(`[full-pipeline] wrote: ${lemmyPayloadPath}`);
    log(`[full-pipeline] wrote: ${lemmyBodyPath}`);

    const publishCfg = normalizePublishConfig({
      env: process.env,
      adapter: GREY_ADAPTER,
      fallbackCommand: "",
    });
    publishStatus = {
      mode: "skip",
      command_source_env: publishCfg.command_source_env || "",
      dry_run: Boolean(publishCfg.dry_run),
      community_name: publishCfg.community_name || "",
    };
    const submitCommand = String(publishCfg.command || "").trim();
    if (!submitCommand) {
      log("[full-pipeline] submit skipped (set GREY_LEMMY_POST_COMMAND or MEETING_POST_COMMAND)");
      publishStatus.mode = "skip_no_command";
      return;
    }

    log(`[full-pipeline] submit command: ${submitCommand}`);
    await runSubmitHook(submitCommand, lemmyPayloadPath);
    publishStatus.mode = publishCfg.dry_run ? "dry_run" : "submitted";
  }, {
    skipWhen: () => skipLemmy || (!forcePostStage && existsFile(lemmyPayloadPath) && existsFile(lemmyBodyPath) && hasSuccessfulMeetingPublishResponse(transcriptDir)),
    inputArtifacts: [meetingSummaryMd, meetingHookTxt, htmlPath],
    outputArtifacts: [lemmyPayloadPath, lemmyBodyPath],
    validationFlags: {
      skip_post: skipLemmy,
      force_post_stage: forcePostStage,
    },
  });

  const reportPath = artifacts.full_pipeline_report_pya;
  const legacyReportJsonPath = path.join(transcriptDir, `${normPrefix}.full-pipeline.report.json`);
  savePyaReportArtifact(reportPath, {
    report_version: "phase1-stage-report-v1",
    writer: GREY_ADAPTER.writer_id,
    source: GREY_ADAPTER.source_id,
    meeting_id: meetingId || "",
    run_id: runId,
    transcript_dir: transcriptDir,
    base_prefix: basePrefix,
    normalized_prefix: normPrefix,
    focus,
    jurisdiction,
    body,
    site_url: siteUrl,
    discussion_url: discussionUrl,
    voices_base_dir: baseVoicesDir,
    voices_work_dir: voicesWorkDir,
    audio_seconds: audioSeconds,
    stages: stageStatus,
    stage_runs: stageRunner.getStageRuns(),
    outputs: {
      normalized_plain: normalizedPlain,
      speaker_srt: speakerSrt,
      agenda_summary_pya: agendaSummaryPya,
      meeting_summary_chunks_pya: meetingSummaryChunksPya,
      meeting_summary_pya: meetingSummaryPya,
      meeting_summary_md: meetingSummaryMd,
      meeting_hook_txt: meetingHookTxt,
      html: htmlPath,
      image: freshCoverImagePath(),
      lemmy_payload: lemmyPayloadPath,
    },
    validation_flags: {
      has_cover_image: existsArtifact(coverImageStablePath) || existsArtifact(coverImagePath),
      has_publish_response: hasSuccessfulMeetingPublishResponse(transcriptDir),
      speaker_checkpoint_valid: speakerCheckpointValid(),
      relabel_checkpoint_valid: relabelCheckpointValid(),
      required_sections_ok: Boolean(qualityVerifier?.checks?.required_sections?.ok),
      truncation_ok: Boolean(qualityVerifier?.checks?.truncation?.ok),
      tense_ok: Boolean(qualityVerifier?.checks?.tense?.ok),
      identity_scoping_ok: Boolean(qualityVerifier?.checks?.identity_scoping?.ok),
      verifier_has_error: Boolean(qualityVerifier?.summary?.has_error),
      verifier_has_warn: Boolean(qualityVerifier?.summary?.has_warn),
      publish_mode: publishStatus.mode,
      publish_dry_run: Boolean(publishStatus.dry_run),
      publish_has_command: Boolean(publishStatus.command_source_env || publishStatus.mode === "submitted" || publishStatus.mode === "dry_run"),
    },
    publish: publishStatus,
    verifier_results: qualityVerifier,
    generated_at_utc: new Date().toISOString(),
  });
  if (existsFile(legacyReportJsonPath)) fs.unlinkSync(legacyReportJsonPath);

  log(`[full-pipeline] report: ${reportPath}`);
  log("[full-pipeline] complete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
    process.exit(1);
  });
}
