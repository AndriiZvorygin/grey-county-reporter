#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");
const PYASH_ROOT = path.resolve(PROGRAM_DIR, "../../../..");
const RUN_BIN = path.join(PYASH_ROOT, "run");

function usage() {
  return [
    "Usage: node program/prepare-grey-agenda-subreports-from-converted.mjs <converted_dir> <subreport_dir> <subreport_index_json> [agenda_html_path] [meeting_url]",
    "Selects the richest converted agenda markdown (largest agenda-*.md), prunes it, then extracts subreports.",
  ].join("\n");
}

function runWithStreaming({ cmd, args, cwd = PYASH_ROOT, timeoutMs = 10 * 60 * 1000, label = "stage" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(10_000, Number(timeoutMs) || 10_000));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label} failed (code=${code ?? "null"} signal=${signal ?? ""})\n${stderr || stdout}`.trim()));
    });
  });
}

function pickLargestAgendaMarkdown(convertedDir) {
  if (!fs.existsSync(convertedDir)) return "";
  const files = fs.readdirSync(convertedDir)
    .filter((n) => /^agenda-\d+\.md$/iu.test(n))
    .map((name) => {
      const full = path.join(convertedDir, name);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      return { name, full, size: Number(st?.size || 0), mtime: Number(st?.mtimeMs || 0) };
    })
    .sort((a, b) => b.size - a.size || b.mtime - a.mtime || a.name.localeCompare(b.name));
  return files.length ? files[0].full : "";
}

async function main() {
  const convertedDir = path.resolve(process.cwd(), process.argv[2] || "");
  const subreportDir = path.resolve(process.cwd(), process.argv[3] || "");
  const subreportIndexPath = path.resolve(process.cwd(), process.argv[4] || "");
  const agendaHtmlPath = String(process.argv[5] || "");
  const meetingUrl = String(process.argv[6] || "");

  if (!convertedDir || !subreportDir || !subreportIndexPath) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const agendaMdPath = pickLargestAgendaMarkdown(convertedDir);
  if (!agendaMdPath || !fs.existsSync(agendaMdPath)) {
    process.stdout.write("[agenda-subreports] no agenda markdown found; skipping subreport extraction\n");
    process.exit(0);
  }

  fs.mkdirSync(subreportDir, { recursive: true });
  const agendaMdStat = fs.statSync(agendaMdPath);
  process.stdout.write(`[agenda-subreports] selected agenda markdown: ${agendaMdPath}\n`);
  process.stdout.write(`[agenda-subreports] selected size bytes: ${Number(agendaMdStat.size || 0)}\n`);

  const prunedPath = agendaMdPath.replace(/\.md$/iu, ".pruned.md");
  await runWithStreaming({
    cmd: "node",
    args: [path.join(HOUSE_ROOT, "program/prune-grey-county-agenda.mjs"), agendaMdPath, prunedPath],
    cwd: PYASH_ROOT,
    timeoutMs: 2 * 60 * 1000,
    label: "prune-agenda",
  });

  const extractSubreportsPya = path.join(HOUSE_ROOT, "program/extract-subreports-fromstate-wo-escribe-full.pya");
  await runWithStreaming({
    cmd: RUN_BIN,
    args: [extractSubreportsPya, agendaMdPath, subreportDir, subreportIndexPath, agendaHtmlPath, meetingUrl],
    cwd: PYASH_ROOT,
    timeoutMs: 10 * 60 * 1000,
    label: "extract-subreports",
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
