#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractHybridPdfText } from "../../../../program/library/reporter_shared/hybrid-pdf-text.mjs";
import {
  closePdfBrowser,
  downloadPdfThroughBrowser,
  isEscribeUrl,
} from "../../../../program/library/reporter_shared/escribe-pdf-download.mjs";

const normalize = (value = "") => String(value)
  .replace(/[\u00a0\u2007\u202f]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const decode = (value = "") => normalize(String(value)
  .replace(/&#(\d+);/gu, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/giu, (_m, n) => String.fromCodePoint(Number.parseInt(n, 16)))
  .replace(/&nbsp;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&quot;/giu, '"')
  .replace(/&apos;|&#39;/giu, "'")
  .replace(/<br\s*\/?\s*>/giu, "\n")
  .replace(/<[^>]+>/gu, " "));

const itemKey = (value = "") => normalize(value).toLowerCase().replace(/\.$/u, "");
const slugify = (value = "") => String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 90) || "item";
const words = (value = "") => normalize(value).split(/\s+/u).filter(Boolean).length;

function isPdfFile(filePath) {
  try {
    return fs.readFileSync(filePath).subarray(0, 5).toString("ascii") === "%PDF-";
  } catch {
    return false;
  }
}

export function readCachedPdfText(pdfPath, textPath) {
  try {
    const pdfStat = fs.statSync(pdfPath);
    const textStat = fs.statSync(textPath);
    if (!pdfStat.isFile() || !textStat.isFile() || textStat.mtimeMs < pdfStat.mtimeMs) return "";
    const text = fs.readFileSync(textPath, "utf8").trim();
    return words(text) >= 16 ? text : "";
  } catch {
    return "";
  }
}

function resolveUrl(value, baseUrl = "") {
  const href = decode(value);
  if (!href) return "";
  try {
    const base = baseUrl ? `${new URL(baseUrl).origin}/` : undefined;
    return new URL(href, base).toString();
  } catch { return href; }
}

/** Parse every structured agenda item. Attachment presence is deliberately not a filter. */
export function parseCanonicalAgendaHtml(htmlText, { baseUrl = "" } = {}) {
  const html = String(htmlText || "");
  const itemRe = /<div\b[^>]*class=(['"])[^'"]*\bAgendaItem\s+AgendaItem(\d+)\b[^'"]*\1[^>]*>[\s\S]*?<div\b[^>]*class=(['"])[^'"]*\bAgendaItemCounter\b[^'"]*\3[^>]*>([\s\S]*?)<\/div>[\s\S]*?<div\b[^>]*class=(['"])[^'"]*\bAgendaItemTitle\b[^'"]*\5[^>]*>([\s\S]*?)<\/div>/giu;
  const canonical = [];
  const byId = new Map();
  let match;
  while ((match = itemRe.exec(html))) {
    const id = Number(match[2]);
    const item = itemKey(decode(match[4]));
    const title = decode(match[6]);
    if (!item || !title || byId.has(id)) continue;
    const row = { id, item, title, description: "", attachments: [], order: canonical.length };
    canonical.push(row);
    byId.set(id, row);
  }

  // Some eScribe themes omit the second AgendaItem class. Keep the same authoritative fields.
  if (!canonical.length) {
    const loose = /<div\b[^>]*class=(['"])[^'"]*\bAgendaItem(\d+)\b[^'"]*\1[^>]*>[\s\S]*?<div\b[^>]*class=(['"])[^'"]*\bAgendaItemCounter\b[^'"]*\3[^>]*>([\s\S]*?)<\/div>[\s\S]*?<div\b[^>]*class=(['"])[^'"]*\bAgendaItemTitle\b[^'"]*\5[^>]*>([\s\S]*?)<\/div>/giu;
    while ((match = loose.exec(html))) {
      const id = Number(match[2]);
      const item = itemKey(decode(match[4]));
      const title = decode(match[6]);
      if (!item || !title || byId.has(id)) continue;
      const row = { id, item, title, description: "", attachments: [], order: canonical.length };
      canonical.push(row);
      byId.set(id, row);
    }
  }

  const descriptionRe = /<div\b[^>]*class=(['"])[^'"]*\bAgendaItemDescription\s+AgendaItemDescription(\d+)\b[^'"]*\1[^>]*>([\s\S]*?)<\/div>/giu;
  while ((match = descriptionRe.exec(html))) {
    const row = byId.get(Number(match[2]));
    if (row) row.description = decode(match[3]);
  }

  const attachmentRe = /<div\b[^>]*class=(['"])[^'"]*\bAgendaItemAttachment\s+AgendaItemAttachment(\d+)\b[^'"]*\1[^>]*>[\s\S]*?<a\b[^>]*href=(['"])(.*?)\3[^>]*>([\s\S]*?)<\/a>/giu;
  while ((match = attachmentRe.exec(html))) {
    const row = byId.get(Number(match[2]));
    const url = resolveUrl(match[4], baseUrl);
    if (!row || !url || row.attachments.some((a) => a.url === url)) continue;
    row.attachments.push({ label: decode(match[5]) || `Attachment ${row.attachments.length + 1}`, url });
  }
  return canonical;
}

function pageMarkers(lines) {
  const out = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const m = normalize(lines[i]).match(/^Page\s+(\d+)\s+of\s+(\d+)$/iu);
    if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), i);
  }
  return out;
}

function findCanonicalAnchor(lines, row, from = 0) {
  const exact = new RegExp(`^${row.item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.?(?:\\s|$)`, "iu");
  const titleTokens = normalize(row.title).toLowerCase().split(/\W+/u).filter((x) => x.length > 3).slice(0, 7);
  for (let i = from; i < lines.length; i += 1) {
    const text = normalize(lines[i]);
    if (!exact.test(text)) continue;
    const probe = normalize(lines.slice(i, i + 8).join(" ")).toLowerCase();
    if (!titleTokens.length || titleTokens.filter((t) => probe.includes(t)).length >= Math.min(2, titleTokens.length)) return i;
  }
  return -1;
}

export function reconcileCombinedPackage(canonicalItems, markdownText) {
  const lines = String(markdownText || "").split(/\r?\n/u);
  const markers = pageMarkers(lines);
  let cursor = 0;
  const anchored = canonicalItems.map((row) => {
    const line = findCanonicalAnchor(lines, row, cursor);
    if (line >= 0) cursor = line + 1;
    return { ...row, package_anchor_line: line };
  });
  return anchored.map((row, index) => {
    // A direct attachment owns the source. Combined-package text is never added to that bundle.
    if (row.attachments.length) return { ...row, package_text: "", package_start_page: null, package_end_page: null };
    const start = row.package_anchor_line;
    if (start < 0) return { ...row, package_text: "", package_start_page: null, package_end_page: null };
    const next = anchored.slice(index + 1).find((candidate) => candidate.package_anchor_line > start);
    const end = next ? next.package_anchor_line - 1 : lines.length - 1;
    const nextAttached = anchored.slice(index + 1).find((candidate) => candidate.attachments.length && candidate.package_anchor_line >= 0);
    if (nextAttached && end >= nextAttached.package_anchor_line) {
      return { ...row, package_text: "", package_start_page: null, package_end_page: null, rejected_range: "crosses_known_attachment_owner" };
    }
    const pageAt = (line) => [...markers.entries()].filter(([, at]) => at <= line).at(-1)?.[0] ?? null;
    return {
      ...row,
      package_text: lines.slice(start, end + 1).join("\n").trim(),
      package_start_page: pageAt(start),
      package_end_page: pageAt(end),
    };
  });
}

async function extractPdf(attachment, attachmentDir, stem, browserState, browserPageUrl = "") {
  const pdfPath = path.join(attachmentDir, `${stem}.pdf`);
  const textPath = path.join(attachmentDir, `${stem}.txt`);
  if (!isPdfFile(pdfPath)) {
    if (isEscribeUrl(attachment.url)) {
      try {
        await downloadPdfThroughBrowser({ url: attachment.url, pdfPath, pageUrl: browserPageUrl, browserState });
      } catch (error) {
        return { text: "", error: `browser_download_failed: ${String(error?.message || error)}`, local_file: "" };
      }
    } else {
      const downloaded = spawnSync("curl", ["-fsSL", "--max-time", "60", "-o", pdfPath, attachment.url], { encoding: "utf8", timeout: 70_000 });
      if (downloaded.error || downloaded.status !== 0) {
        return { text: "", error: `download_exit_${downloaded.status ?? "error"}`, local_file: "" };
      }
    }
  }
  if (!isPdfFile(pdfPath)) return { text: "", error: "response_not_pdf", local_file: "" };
  const cachedText = readCachedPdfText(pdfPath, textPath);
  if (cachedText) {
    return { text: cachedText, error: "", cached: true, ocr_pages: [], page_count: null, local_file: pdfPath };
  }
  try {
    const bytes = fs.readFileSync(pdfPath);
    if (bytes.length < 8 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      if (isEscribeUrl(attachment.url)) {
        await downloadPdfThroughBrowser({ url: attachment.url, pdfPath, pageUrl: browserPageUrl, browserState });
      } else {
        fs.unlinkSync(pdfPath);
        return { text: "", error: "response_not_pdf", local_file: "" };
      }
    }
  } catch {
    return { text: "", error: "download_missing", local_file: "" };
  }
  try {
    const extracted = await extractHybridPdfText({ pdfPath, textPath, allowImageOnly: true });
    return words(extracted.text) >= 16
      ? { text: extracted.text, error: "", ocr_pages: extracted.ocrPages, page_count: extracted.totalPages, local_file: pdfPath }
      : { text: "", error: "empty_or_image_only", ocr_pages: extracted.ocrPages, page_count: extracted.totalPages, local_file: pdfPath };
  } catch (error) {
    return { text: "", error: `hybrid_pdf_extract_failed: ${String(error?.message || error)}`, local_file: pdfPath };
  }
}

export async function buildCanonicalSourceBundles({ canonicalItems, packageMarkdown = "", outputDir, sourceBaseUrl = "", downloadAttachments = true }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const attachmentDir = path.join(outputDir, "_attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  const reconciled = reconcileCombinedPackage(canonicalItems, packageMarkdown);
  const seenUrls = new Map();
  const items = [];
  const browserState = { browser: null, page: null, pageUrl: "" };
  try {
  for (const row of reconciled) {
    const parts = [`Agenda item ${row.item}: ${row.title}`];
    if (row.description) parts.push(`Agenda description\n\n${row.description}`);
    const diagnostics = [];
    for (let i = 0; i < row.attachments.length; i += 1) {
      const attachment = row.attachments[i];
      const priorOwner = seenUrls.get(attachment.url);
      if (priorOwner && priorOwner !== row.item) throw new Error(`attachment ${attachment.url} assigned to both ${priorOwner} and ${row.item}`);
      seenUrls.set(attachment.url, row.item);
      if (!downloadAttachments) continue;
      const extracted = await extractPdf(
        attachment,
        attachmentDir,
        `${row.item.replace(/\./gu, "-")}-${i + 1}-${slugify(attachment.label)}`,
        browserState,
        sourceBaseUrl,
      );
      diagnostics.push({ ...attachment, status: extracted.text ? "extracted" : extracted.error, cached: extracted.cached === true, ocr_pages: extracted.ocr_pages || [], page_count: extracted.page_count || null, local_file: extracted.local_file || "" });
      if (!extracted.text && String(extracted.error || "").startsWith("hybrid_pdf_extract_failed:")) {
        throw new Error(`attachment extraction remains retryable for ${row.item}: ${extracted.error}`);
      }
      if (extracted.text) parts.push(`Attachment: ${attachment.label}\nSource: ${attachment.url}\n\n${extracted.text}`);
    }
    if (!row.attachments.length && row.package_text) parts.push(`Combined agenda package (secondary source)\n\n${row.package_text}`);
    const text = parts.join("\n\n---\n\n").trim();
    const file = text ? path.join(outputDir, `${row.item.replace(/\./gu, "-")}_${slugify(row.title)}.md`) : null;
    if (file) fs.writeFileSync(file, `${text}\n`, "utf8");
    const minutesLike = /\bminutes\b/iu.test(row.title);
    const decisionSignals = (text.match(/\b(?:recommend(?:ed|ation)?|resolution|moved by|carried|approved|directed|authorized)\b/giu) || []).length;
    const procedural = /\b(?:call to order|disclosures? of (?:pecuniary )?interest|public forum|confirm(?:ation)? of agenda|adjournment)\b/iu.test(row.title)
      || (minutesLike && decisionSignals < 4);
    const sourceWordCount = words(text);
    items.push({
      item: row.item, title: row.title, description: row.description, order: row.order,
      file, has_page_slice: Boolean(!row.attachments.length && row.package_text),
      extraction_method: row.attachments.length ? "direct_attachments" : (row.package_text ? "canonical_html_package_reconciliation" : "description_only"),
      start_page: row.package_start_page, end_page: row.package_end_page,
      attachments: row.attachments, attachment_diagnostics: diagnostics,
      source_urls: row.attachments.map((a) => a.url), substantive: row.attachments.length > 0 || sourceWordCount >= 80,
      long_source: sourceWordCount >= 700 && (!minutesLike || decisionSignals >= 4), procedural,
      minutes_like: minutesLike, decision_signal_count: decisionSignals,
      source_word_count: sourceWordCount, rejected_range: row.rejected_range || "",
    });
  }
  return items;
  } finally {
    await closePdfBrowser(browserState);
  }
}

export async function main() {
  const [, , inputPath, outputDirArg, outputIndexArg, agendaHtmlPath, sourceBaseUrl] = process.argv;
  if ((!inputPath && !agendaHtmlPath) || !outputDirArg) throw new Error("usage: extract-escribe-agenda-items.mjs [agenda.md] <output_dir> [index.json] [agenda.html] [meeting_url]");
  if (!agendaHtmlPath || !fs.existsSync(path.resolve(agendaHtmlPath))) {
    const legacy = spawnSync("node", ["/home/htaf/pyash/command/extract_escribe_subreports.mjs", inputPath, outputDirArg, outputIndexArg || "", agendaHtmlPath || "", sourceBaseUrl || ""], { stdio: "inherit" });
    process.exitCode = legacy.status ?? 1;
    return;
  }
  const outputDir = path.resolve(outputDirArg);
  const html = fs.readFileSync(path.resolve(agendaHtmlPath), "utf8");
  const canonicalItems = parseCanonicalAgendaHtml(html, { baseUrl: sourceBaseUrl });
  if (!canonicalItems.length) throw new Error("structured agenda HTML contained no canonical agenda items");
  const packageMarkdown = inputPath && fs.existsSync(path.resolve(inputPath))
    ? fs.readFileSync(path.resolve(inputPath), "utf8")
    : "";
  const items = await buildCanonicalSourceBundles({ canonicalItems, packageMarkdown, outputDir, sourceBaseUrl });
  const index = {
    schema_version: "canonical_escribe_agenda_v2", authoritative_source: path.resolve(agendaHtmlPath),
    secondary_source: inputPath ? path.resolve(inputPath) : "", generated_at_utc: new Date().toISOString(), items,
    sections: items.filter((x) => x.file), attachments_from_html: items.filter((x) => x.attachments.length).map((x) => ({ item: x.item, title: x.title, attachments: x.attachments })),
  };
  const indexPath = outputIndexArg ? path.resolve(outputIndexArg) : path.join(outputDir, "subreports.index.json");
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  process.stdout.write(`[agenda-subreports] canonical HTML items: ${items.length}; source bundles: ${items.filter((x) => x.file).length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
}
