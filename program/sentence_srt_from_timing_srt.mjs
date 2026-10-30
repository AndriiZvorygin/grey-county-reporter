import fs from "node:fs";
import path from "node:path";

function usage() {
  return "Usage: node program/sentence_srt_from_timing_srt.mjs <timing.srt> <output.srt>";
}

function parseSrtTime(ts) {
  const m = String(ts || "").trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function formatSrtTime(sec) {
  const v = Math.max(0, Number(sec) || 0);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  const ms = Math.round((v - Math.floor(v)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function parseTimingSrt(content) {
  const blocks = String(content || "").split(/\r?\n\r?\n/u).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/u);
    if (lines.length < 3) continue;
    const timing = lines[1] || "";
    const m = timing.match(/^(.+?)\s+-->\s+(.+)$/u);
    if (!m) continue;
    const since = parseSrtTime(m[1]);
    const until = parseSrtTime(m[2]);
    if (!Number.isFinite(since) || !Number.isFinite(until)) continue;
    const text = lines.slice(2).join(" ").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    out.push({ since, until, text });
  }
  return out;
}

function looksLikeSentenceEnd(token) {
  return /[.!?]["')\]]*$/u.test(token);
}

function stitchTokens(tokens) {
  const joined = tokens.join(" ").replace(/\s+/gu, " ").trim();
  return joined
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([(\[{])\s+/gu, "$1")
    .replace(/\s+([)\]}])/gu, "$1")
    .trim();
}

function emitSentenceSrt(rows) {
  const maxSentenceSeconds = 16;
  const maxSentenceWords = 42;
  const pauseBreakSeconds = 0.9;
  const out = [];
  let cur = null;

  function flush() {
    if (!cur || !cur.tokens.length) return;
    const text = stitchTokens(cur.tokens);
    if (text) out.push({ since: cur.since, until: cur.until, text });
    cur = null;
  }

  for (const row of rows) {
    if (!cur) {
      cur = { since: row.since, until: row.until, tokens: [row.text] };
      continue;
    }
    const gap = row.since - cur.until;
    if (Number.isFinite(gap) && gap > pauseBreakSeconds) flush();
    if (!cur) {
      cur = { since: row.since, until: row.until, tokens: [row.text] };
      continue;
    }
    cur.tokens.push(row.text);
    cur.until = Math.max(cur.until, row.until);

    const duration = cur.until - cur.since;
    const words = cur.tokens.length;
    const ended = looksLikeSentenceEnd(row.text);
    if (ended || duration >= maxSentenceSeconds || words >= maxSentenceWords) flush();
  }
  flush();
  return out;
}

function toSrt(rows) {
  return rows.map((r, i) => `${i + 1}\n${formatSrtTime(r.since)} --> ${formatSrtTime(r.until)}\n${r.text}`).join("\n\n");
}

function main() {
  const [timingPath, outputPath] = process.argv.slice(2);
  if (!timingPath || !outputPath) {
    console.error(usage());
    process.exit(2);
  }
  if (!fs.existsSync(timingPath)) throw new Error(`timing srt not found: ${timingPath}`);
  const rows = parseTimingSrt(fs.readFileSync(timingPath, "utf8"));
  if (!rows.length) throw new Error(`no timing rows parsed: ${timingPath}`);
  const sentenceRows = emitSentenceSrt(rows);
  if (!sentenceRows.length) throw new Error(`no sentence rows emitted: ${timingPath}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${toSrt(sentenceRows)}\n`, "utf8");
  console.log(outputPath);
}

main();
