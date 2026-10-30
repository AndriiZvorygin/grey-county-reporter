#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  closePdfBrowser,
  downloadPdfThroughBrowser,
  isEscribeUrl,
} from "../../../../program/library/reporter_shared/escribe-pdf-download.mjs";

function usage() {
  return "Usage: node program/ensure-agenda-markdown-from-pdf.mjs <source_pdf> <output_md> [source_url] [meeting_page_url]";
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function isPdfFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(5);
    return fs.readSync(fd, header, 0, header.length, 0) === header.length
      && header.toString("ascii") === "%PDF-";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function ensurePdfSource({
  sourcePdf,
  sourceUrl = "",
  meetingPageUrl = "",
  browserState = { browser: null, page: null, pageUrl: "" },
  downloadPdf = downloadPdfThroughBrowser,
} = {}) {
  if (isPdfFile(sourcePdf)) return { isPdf: true, attemptedBrowser: false, error: "" };
  if (!isEscribeUrl(sourceUrl)) return { isPdf: false, attemptedBrowser: false, error: "response_not_pdf" };

  try {
    await downloadPdf({
      url: sourceUrl,
      pdfPath: sourcePdf,
      pageUrl: meetingPageUrl,
      browserState,
    });
  } catch (error) {
    return {
      isPdf: false,
      attemptedBrowser: true,
      error: String(error?.message || error || "browser_download_failed"),
    };
  }
  return {
    isPdf: isPdfFile(sourcePdf),
    attemptedBrowser: true,
    error: isPdfFile(sourcePdf) ? "" : "browser_response_not_pdf",
  };
}

function buildMarkdownFromPdfText(text) {
  const src = String(text || "").replace(/\r/g, "");
  const pages = src.split("\f");
  const cleaned = pages
    .map((page) => String(page || "").trim())
    .filter(Boolean);
  const total = cleaned.length;
  if (!total) return "";
  const out = [];
  for (let i = 0; i < total; i += 1) {
    out.push(`Page ${i + 1} of ${total}`);
    out.push(cleaned[i]);
    out.push("");
  }
  return `${out.join("\n").trim()}\n`;
}

async function main() {
  const sourcePdf = process.argv[2];
  const outputMd = process.argv[3];
  const sourceUrl = process.argv[4] || "";
  const meetingPageUrl = process.argv[5] || "";
  if (!sourcePdf || !outputMd) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (!fs.existsSync(sourcePdf)) {
    process.stderr.write(`source pdf missing: ${sourcePdf}\n`);
    process.exitCode = 1;
    return;
  }

  const browserState = { browser: null, page: null, pageUrl: "" };
  let pdfSource;
  try {
    // eScribe/Cloudflare can return an HTML challenge under a PDF URL. Retry
    // through a browser session before giving up on this secondary package.
    pdfSource = await ensurePdfSource({ sourcePdf, sourceUrl, meetingPageUrl, browserState });
  } finally {
    await closePdfBrowser(browserState);
  }
  if (!pdfSource.isPdf) {
    const retry = pdfSource.attemptedBrowser ? `; browser retry failed: ${pdfSource.error}` : "";
    process.stdout.write(`agenda source is not a PDF; skipping optional package conversion${retry}: ${sourcePdf}\n`);
    return;
  }

  const existing = readText(outputMd).trim();
  if (existing && !pdfSource.attemptedBrowser) {
    process.stdout.write(`agenda markdown already present: ${outputMd}\n`);
    return;
  }

  const tmpPath = `${outputMd}.pdftotext.tmp.txt`;
  const run = spawnSync("pdftotext", [sourcePdf, tmpPath], { encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(`pdftotext failed for ${sourcePdf}\n`);
    process.exitCode = 1;
    return;
  }

  const extracted = readText(tmpPath);
  const rebuilt = buildMarkdownFromPdfText(extracted);
  fs.rmSync(tmpPath, { force: true });
  if (!rebuilt.trim()) {
    process.stderr.write(`no text extracted from pdf: ${sourcePdf}\n`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(outputMd, rebuilt, "utf8");
  process.stdout.write(`rebuilt agenda markdown from pdf: ${outputMd}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
