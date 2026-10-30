#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_SUMMARY_FOCUS } from "./defaults.mjs";

const HOUSE = "/home/htaf/pyac/pyash/world/house/grey-county-reporter";
const MEETINGS_DIR = path.join(HOUSE, "artifacts/grey-county/meetings");
const RUNNER = path.join(HOUSE, "program/run-grey-county-meeting-from-ref.mjs");
const TZ = "America/Toronto";

function todayToronto() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function runNode(args, env = {}) {
  return spawnSync("node", args, {
    cwd: "/home/htaf/pyac/pyash",
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

function main() {
  const day = todayToronto();
  const todayPath = path.join(MEETINGS_DIR, `${day}.today.json`);
  if (!fs.existsSync(todayPath)) {
    process.stdout.write(`no today workspace file: ${todayPath}\n`);
    process.exit(0);
  }

  const today = JSON.parse(fs.readFileSync(todayPath, "utf8"));
  const meetings = Array.isArray(today.meetings) ? today.meetings : [];
  const basePrefix = String(today.base_prefix || process.env.GREY_TODAY_BASE_PREFIX || "meeting-qwen-auto");
  const force = /^(1|true|yes)$/iu.test(String(process.env.GREY_TODAY_FORCE || "0"));
  const results = [];

  for (const m of meetings) {
    const meetingRef = String(m?.meeting_ref || "");
    const meetingDir = String(m?.meeting_dir || "");
    const payloadPath = meetingDir
      ? path.join(meetingDir, "transcript", `${basePrefix}-normalized.lemmy-post.json`)
      : "";

    if (!force && payloadPath && fs.existsSync(payloadPath)) {
      results.push({
        meeting_id: m?.meeting_id || "",
        meeting_name: m?.meeting_name || "",
        meeting_ref: meetingRef,
        meeting_dir: meetingDir,
        ok: true,
        skipped: true,
        note: "payload exists",
        payload_path: payloadPath,
      });
      continue;
    }

    const run = runNode(
      [
        RUNNER,
        meetingRef,
        basePrefix,
        process.env.GREY_TODAY_FOCUS || DEFAULT_SUMMARY_FOCUS,
        process.env.GREY_TODAY_JURISDICTION || "Grey County",
        process.env.GREY_TODAY_BODY || "auto",
        process.env.GREY_TODAY_SITE_URL || "https://helpos.ca",
        process.env.GREY_TODAY_DISCUSSION_URL || "",
      ],
      {
        GREY_PIPELINE_SKIP_PREP: "1",
      },
    );

    results.push({
      meeting_id: m?.meeting_id || "",
      meeting_name: m?.meeting_name || "",
      meeting_ref: meetingRef,
      meeting_dir: meetingDir,
      transcript_dir: meetingDir ? path.join(meetingDir, "transcript") : "",
      payload_path: payloadPath,
      ok: (run.status ?? 1) === 0,
      skipped: false,
      exit_code: run.status ?? 1,
      stdout_preview: String(run.stdout || "").slice(0, 3000),
      stderr_preview: String(run.stderr || "").slice(0, 3000),
    });
  }

  const summary = {
    day,
    meeting_count: meetings.length,
    ran_count: results.filter((x) => !x.skipped).length,
    skipped_count: results.filter((x) => x.skipped).length,
    ok_count: results.filter((x) => x.ok).length,
    fail_count: results.filter((x) => !x.ok).length,
    results,
    generated_at_utc: new Date().toISOString(),
  };
  const summaryPath = path.join(MEETINGS_DIR, `${day}.run-summary.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(
    `ran ${summary.ran_count} meeting pipelines (${summary.ok_count} ok, ${summary.fail_count} failed, ${summary.skipped_count} skipped)\n`,
  );
  process.stdout.write(`summary: ${summaryPath}\n`);
}

main();
