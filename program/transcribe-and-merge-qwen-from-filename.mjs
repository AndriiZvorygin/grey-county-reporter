#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { hearRetryDelayMs, isRetryableHearError } from "../../owen-sound-reporter/program/shared/qwen-hear-retry.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const RUN_BIN = path.join(ROOT, "run");
const PREDECODE_PCM_ENABLED = !/^(0|false|no)$/iu.test(String(
  process.env.GREY_QWEN_PREDECODE_PCM
  || process.env.PYA_QWEN_PREDECODE_PCM
  || "1",
));

function usage() {
  return [
    "Usage: node program/transcribe-and-merge-qwen-from-filename.mjs <audio_filename> <output_dir> [prefix]",
    "Example: node ... meeting-audio.opus world/house/grey-county-reporter/artifacts/grey-county/meetings/test/transcript meeting-qwen-auto",
  ].join("\n");
}

function ensureFile(filePath) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new Error(`file not found: ${filePath}`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function streamLines(stream, onLine) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += String(chunk ?? "");
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() || "";
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    const tail = pending.trim();
    if (tail) onLine(tail);
  });
}

function decodePyaQuotedText(raw) {
  try {
    return JSON.parse(`"${String(raw ?? "").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`);
  } catch {
    return String(raw ?? "");
  }
}

function runPyash(programPath, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(RUN_BIN, [programPath, ...args, "--verbose"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutAll = "";
    let stderrAll = "";
    let lastProgress = "";
    let lastPreview = "";
    const progressRe = /fromindex num (\d+).*toindex num (\d+)(?:.*atindex num (\d+))?/u;
    const previewRe = /fromtext text "((?:[^"\\]|\\.)*)"/u;

    streamLines(proc.stdout, (line) => {
      stdoutAll += `${line}\n`;
      const m = progressRe.exec(line);
      if (m) {
        const idx = Number(m[1]);
        const total = Number(m[2]);
        const segs = m[3] ? Number(m[3]) : null;
        const next = segs
          ? `[qwen-merge] atindex num ${idx} toindex num ${total} by num ${segs}`
          : `[qwen-merge] atindex num ${idx} toindex num ${total}`;
        if (next !== lastProgress) {
          lastProgress = next;
          process.stdout.write(`${next}\n`);
        }
      }
      if (!line.includes("su name hear qwen chunk result")) return;
      const pm = previewRe.exec(line);
      if (pm) {
        const preview = decodePyaQuotedText(pm[1]).replace(/\s+/gu, " ").trim();
        if (preview && preview !== lastPreview) {
          lastPreview = preview;
          process.stdout.write(`[qwen-merge] transcript ${preview}\n`);
        }
      }
    });

    streamLines(proc.stderr, (line) => {
      stderrAll += `${line}\n`;
      process.stderr.write(`${line}\n`);
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) return resolve(stdoutAll);
      reject(new Error(`pyash run failed (code=${code})\n${stderrAll || stdoutAll}`));
    });
  });
}

function copyFileChecked(src, dest) {
  ensureFile(src);
  fs.copyFileSync(src, dest);
}

function configuredPositiveInt(name, fallback) {
  const value = Number(String(process.env[name] || "").trim());
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function waitMs(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(durationMs) || 0)));
}

function ensurePcmSource({ audioPath, tmpDir }) {
  const pcmPath = path.join(tmpDir, "source-16k-mono.wav");
  execFileSync("ffmpeg", [
    "-nostdin",
    "-y",
    "-i", audioPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    pcmPath,
  ], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  ensureFile(pcmPath);
  return pcmPath;
}

async function dischargeHearBackend() {
  try {
    await runPyash("examples/pyash/discharge-hear-backend.pya", []);
    process.stdout.write("[qwen-merge] discharged hear backend\n");
  } catch (err) {
    process.stderr.write(`[qwen-merge] warn: discharge failed: ${String(err?.message || err)}\n`);
  }
}

async function runHearStageWithRetry(audioPath) {
  const attempts = configuredPositiveInt("QWEN_HEAR_STAGE_ATTEMPTS", 2);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      process.stdout.write(`[qwen-merge] retrying qwen hear stage (${attempt}/${attempts}) after backend discharge\n`);
    }
    try {
      await runPyash("examples/pyash/qwen-hear-srt-and-text-from-filename.pya", [audioPath]);
      return;
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      const retryable = isRetryableHearError(message);
      if (!retryable || attempt >= attempts) break;
      process.stderr.write(`[qwen-merge] warn: qwen hear attempt ${attempt}/${attempts} failed: ${message.split(/\r?\n/u)[0]}\n`);
      await dischargeHearBackend();
      const delayMs = hearRetryDelayMs(attempt);
      process.stdout.write(`[qwen-merge] waiting ${delayMs}ms for hear backend resources to settle\n`);
      await waitMs(delayMs);
    }
  }
  throw lastError || new Error("qwen hear stage failed");
}

async function main() {
  const audioArg = process.argv[2];
  const outputDirArg = process.argv[3];
  const prefixArg = process.argv[4] || "qwen-transcript";
  if (!audioArg || !outputDirArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const audioPath = path.resolve(process.cwd(), audioArg);
  const outputDir = path.resolve(process.cwd(), outputDirArg);
  ensureFile(audioPath);
  ensureDir(outputDir);

  const timingSrt = path.join(outputDir, `${prefixArg}.timing.srt`);
  const plainText = path.join(outputDir, `${prefixArg}.plain.txt`);
  const transcriptText = path.join(outputDir, `${prefixArg}.transcript.txt`);
  const mergedSrt = path.join(outputDir, `${prefixArg}.merged.srt`);

  process.stdout.write(`[qwen-merge] audio: ${audioPath}\n`);
  process.stdout.write(
    `[qwen-merge] hear host: ${String(process.env.PYA_HEAR_QWEN_HOST || process.env.PYA_DRAW_HOST || "http://localhost:8188").trim()}\n`,
  );
  let sttAudioPath = audioPath;
  let tmpDir = "";

  try {
    if (PREDECODE_PCM_ENABLED) {
      const tempRoot = path.join(ROOT, "world", "temporary");
      fs.mkdirSync(tempRoot, { recursive: true });
      tmpDir = fs.mkdtempSync(path.join(tempRoot, "grey-qwen-predecode-"));
      process.stdout.write("[qwen-merge] predecode: start (mono 16k PCM)\n");
      sttAudioPath = ensurePcmSource({ audioPath, tmpDir });
      process.stdout.write(`[qwen-merge] predecode: ready ${sttAudioPath}\n`);
    }

    process.stdout.write("[qwen-merge] stage 1/3: qwen single-pass (timing + plain)\n");
    await runHearStageWithRetry(sttAudioPath);
    copyFileChecked(path.join(ROOT, "artifacts/hear/qwen-hear-srt-and-text-from-filename.srt"), timingSrt);
    copyFileChecked(path.join(ROOT, "artifacts/hear/qwen-hear-srt-and-text-from-filename.txt"), plainText);

    // Build canonical sentence-level timing first from the raw plain text + source timing.
    // Downstream paragraphization must consume this merged timeline, not raw chunk timing.
    process.stdout.write("[qwen-merge] stage 2/3: align plain text with timing\n");
    const mergeOut = execFileSync("node", [
      path.join(ROOT, "command/lyrics_to_srt_from_timing.mjs"),
      plainText,
      timingSrt,
      mergedSrt
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        PYA_SRT_MAX_DRIFT_SECONDS: String(process.env.PYA_SRT_MAX_DRIFT_SECONDS || "4.0"),
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (mergeOut.trim()) process.stdout.write(`${mergeOut.trim()}\n`);
    ensureFile(mergedSrt);
    process.stdout.write(`[qwen-merge] verified merged: ${mergedSrt}\n`);

    // Canonical grammatical plain text is reconstructed from merged sentence-aligned SRT.
    const mergedToPlainOut = execFileSync("node", [
      path.join(ROOT, "command/srt_to_plain_text.mjs"),
      mergedSrt,
      plainText,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (mergedToPlainOut.trim()) process.stdout.write(`${mergedToPlainOut.trim()}\n`);
    ensureFile(plainText);
    process.stdout.write(`[qwen-merge] rebuilt plain from merged: ${plainText}\n`);

    process.stdout.write("[qwen-merge] stage 3/3: paragraphize merged plain from sentence timing gaps\n");
    const paragraphizeOut = execFileSync("node", [
      path.join(ROOT, "command/paragraphize_plain_from_timing_srt.mjs"),
      plainText,
      mergedSrt,
      plainText,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (paragraphizeOut.trim()) process.stdout.write(`${paragraphizeOut.trim()}\n`);
    fs.copyFileSync(plainText, transcriptText);

    process.stdout.write(`[qwen-merge] wrote timing: ${timingSrt}\n`);
    process.stdout.write(`[qwen-merge] wrote plain: ${plainText}\n`);
    process.stdout.write(`[qwen-merge] wrote transcript: ${transcriptText}\n`);
    process.stdout.write(`[qwen-merge] wrote merged: ${mergedSrt}\n`);
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    await dischargeHearBackend();
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
