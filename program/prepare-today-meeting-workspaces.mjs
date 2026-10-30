#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_SUMMARY_FOCUS } from "./defaults.mjs";

const HOUSE = "/home/htaf/pyac/pyash/world/house/grey-county-reporter";
const MONTHLY_DIR = path.join(HOUSE, "artifacts/grey-county/monthly");
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

function parseSeriesLine(line) {
  const m = line.match(/^su name (.+?) since date (\S+) until date (\S+) ob text "(.+)" ya$/u);
  if (!m) return null;
  const [, suName, since, until, escapedJson] = m;
  try {
    const jsonText = JSON.parse(`"${escapedJson}"`);
    const payload = JSON.parse(jsonText);
    return { suName, since, until, payload };
  } catch {
    return null;
  }
}

function addDays(isoDay, days) {
  const dt = new Date(`${isoDay}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function inRange(dayIso, startIso, endIso) {
  return dayIso >= startIso && dayIso <= endIso;
}

function collectMeetingsInRange(startIso, endIso) {
  if (!fs.existsSync(MONTHLY_DIR)) return [];
  const files = fs.readdirSync(MONTHLY_DIR)
    .filter((n) => n.endsWith(".events.series.pya"))
    .map((n) => path.join(MONTHLY_DIR, n))
    .sort();
  const out = [];
  for (const filePath of files) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const raw of lines) {
      const row = parseSeriesLine(raw.trim());
      if (!row) continue;
      const dayIso = String(row.since || "").slice(0, 10);
      if (!dayIso) continue;
      if (!inRange(dayIso, startIso, endIso)) continue;
      out.push(row);
    }
  }
  out.sort((a, b) => String(a.since).localeCompare(String(b.since)));
  return out;
}

function runNode(args, env = {}) {
  return spawnSync("node", args, {
    cwd: "/home/htaf/pyac/pyash",
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
  });
}

function main() {
  const day = todayToronto();
  const lookaheadDays = Math.max(0, Number(process.env.GREY_TODAY_LOOKAHEAD_DAYS || 1));
  const endDay = addDays(day, lookaheadDays);
  const basePrefix = String(process.env.GREY_TODAY_BASE_PREFIX || "meeting-qwen-auto");
  const focus = String(process.env.GREY_TODAY_FOCUS || DEFAULT_SUMMARY_FOCUS);
  const jurisdiction = String(process.env.GREY_TODAY_JURISDICTION || "Grey County");
  const body = String(process.env.GREY_TODAY_BODY || "auto");
  const siteUrl = String(process.env.GREY_TODAY_SITE_URL || "https://helpos.ca");
  const discussionUrl = String(process.env.GREY_TODAY_DISCUSSION_URL || "");

  fs.mkdirSync(MEETINGS_DIR, { recursive: true });

  const refresh = runNode([path.join(HOUSE, "program/extract-grey-county-calendar-monthly.mjs")]);
  if ((refresh.status ?? 1) !== 0) {
    process.stderr.write(refresh.stderr || refresh.stdout || "calendar refresh failed\n");
    process.exit(1);
  }

  const meetings = collectMeetingsInRange(day, endDay);
  const results = [];

  for (const row of meetings) {
    const payload = row.payload || {};
    const meetingRef = String(payload.meeting_url || payload.meeting_id || "").trim();
    if (!meetingRef) continue;
    const run = runNode(
      [
        RUNNER,
        meetingRef,
        basePrefix,
        focus,
        jurisdiction,
        body,
        siteUrl,
        discussionUrl,
      ],
      {
        GREY_PIPELINE_SKIP_FULL: "1",
        GREY_PREP_FORCE: String(process.env.GREY_PREP_FORCE || "0"),
      },
    );

    const meetingId = String(payload.meeting_id || "");
    const meetingName = String(payload.meeting_name || "");
    const folderPrefix = `${String(row.since || "").slice(0, 10)}_`;
    const meetingFolders = fs.readdirSync(MEETINGS_DIR)
      .filter((n) => n.startsWith(folderPrefix) && (meetingId ? n.endsWith(meetingId.slice(0, 8)) : true))
      .sort();
    const meetingFolder = meetingFolders[meetingFolders.length - 1] || "";
    const meetingDir = meetingFolder ? path.join(MEETINGS_DIR, meetingFolder) : "";

    results.push({
      meeting_id: meetingId,
      meeting_name: meetingName,
      meeting_ref: meetingRef,
      since: row.since,
      until: row.until,
      ok: (run.status ?? 1) === 0,
      exit_code: run.status ?? 1,
      meeting_dir: meetingDir,
      transcript_dir: meetingDir ? path.join(meetingDir, "transcript") : "",
      stdout_preview: String(run.stdout || "").slice(0, 3000),
      stderr_preview: String(run.stderr || "").slice(0, 3000),
    });
  }

  const summary = {
    day,
    window_end_day: endDay,
    lookahead_days: lookaheadDays,
    base_prefix: basePrefix,
    meeting_count: results.length,
    ok_count: results.filter((x) => x.ok).length,
    fail_count: results.filter((x) => !x.ok).length,
    meetings: results,
    generated_at_utc: new Date().toISOString(),
  };
  const outPath = path.join(MEETINGS_DIR, `${day}.today.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.stdout.write(`prepared ${summary.meeting_count} meetings (${summary.ok_count} ok, ${summary.fail_count} failed)\n`);
  process.stdout.write(`summary: ${outPath}\n`);
}

main();
