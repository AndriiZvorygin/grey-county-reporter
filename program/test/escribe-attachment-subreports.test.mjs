import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCanonicalAgendaEvidence,
  selectCanonicalAgendaItemKeys,
} from "../../../../../program/library/reporter_shared/escribe-agenda-identity.mjs";
import { canonicalEscribeMeetingPageUrl } from "../../../../../program/library/reporter_shared/escribe-pdf-download.mjs";
import {
  extractHybridPdfText,
  isPaginationOnlyPageText,
} from "../../../../../program/library/reporter_shared/hybrid-pdf-text.mjs";

const MAIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");
const GREY_EXTRACTOR = path.join(MAIN_ROOT, "world/house/grey-county-reporter/program/extract-escribe-agenda-items.mjs");
const OWEN_PREPARER = path.join(MAIN_ROOT, "world/house/owen-sound-reporter/program/prune-owen-sound-agenda.mjs");

function runNode(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`extractor exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("eScribe attachment PDFs become item-specific subreports when text is meaningful", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyash-escribe-attachments-"));
  const outputDir = path.join(root, "subreports");
  const reportPs = path.join(root, "report.ps");
  const blankPs = path.join(root, "blank.ps");
  const reportPdf = path.join(root, "report.pdf");
  const blankPdf = path.join(root, "blank.pdf");
  fs.writeFileSync(reportPs, [
    "%!PS",
    "/Helvetica findfont 12 scalefont setfont",
    "72 720 moveto",
    "(River District calls increased 17 percent while weapons calls increased 320 percent.) show",
    "72 700 moveto",
    "(Attempted suicide calls increased 200 percent during the first five months of 2026.) show",
    "showpage",
  ].join("\n"), "utf8");
  fs.writeFileSync(blankPs, "%!PS\nshowpage\n", "utf8");
  execFileSync("ps2pdf", [reportPs, reportPdf]);
  execFileSync("ps2pdf", [blankPs, blankPdf]);

  const server = http.createServer((req, res) => {
    const file = req.url === "/report.pdf" ? reportPdf : blankPdf;
    res.writeHead(200, { "content-type": "application/pdf" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const agendaMd = path.join(root, "agenda.md");
  const agendaHtml = path.join(root, "agenda.html");
  const indexPath = path.join(root, "index.json");
  fs.writeFileSync(agendaMd, "CALL TO ORDER\n\nADJOURNMENT\n", "utf8");
  fs.writeFileSync(agendaHtml, [
    "<DIV class='AgendaItem AgendaItem11'>",
    "<DIV class='AgendaItemCounter'>5.a</DIV>",
    "<DIV class='AgendaItemTitle'><a tabindex='0'>River District Statistics Update</a></DIV>",
    `<DIV class='AgendaItemAttachment AgendaItemAttachment11'><a class='Link' href="http://127.0.0.1:${port}/report.pdf"><SPAN class='Link'>River District Statistics.pdf</SPAN></a></DIV>`,
    "</DIV>",
    "<DIV class='AgendaItem AgendaItem12'>",
    "<DIV class='AgendaItemCounter'>6.a</DIV>",
    "<DIV class='AgendaItemTitle'><a tabindex='0'>Scanned Correspondence</a></DIV>",
    `<DIV class='AgendaItemAttachment AgendaItemAttachment12'><a class='Link' href="http://127.0.0.1:${port}/blank.pdf"><SPAN class='Link'>Scanned Letter.pdf</SPAN></a></DIV>`,
    "</DIV>",
  ].join("\n"), "utf8");

  await runNode([
    path.join(MAIN_ROOT, "command/extract_escribe_subreports.mjs"),
    agendaMd,
    outputDir,
    indexPath,
    agendaHtml,
    `http://127.0.0.1:${port}/meeting`,
    agendaMd,
  ], process.cwd(), { PDF_OCR_QWEN_FIXTURE: JSON.stringify({ 1: "[[BLANK PAGE]]" }) });

  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const report = index.items.find((item) => item.item === "5.a");
  const blank = index.items.find((item) => item.item === "6.a");
  assert.equal(report.extraction_method, "attachment_pdf");
  assert.equal(report.has_page_slice, true);
  assert.match(fs.readFileSync(report.file, "utf8"), /weapons calls increased 320 percent/u);
  assert.equal(blank.has_page_slice, false);
  assert.equal(
    index.attachment_extraction_diagnostics
      .find((row) => row.item === "6.a")
      .attachments[0].status,
    "empty_or_image_only",
  );
});

test("structured eScribe agenda identity excludes PDF-only inferred items", () => {
  assert.deepEqual(
    selectCanonicalAgendaItemKeys(
      new Map([
        ["11.a", { title: "Annual Development Update" }],
        ["12", { title: "Discussion of Additional Business" }],
      ]),
      [{ item: "11.a" }, { item: "12" }, { item: "11.b" }],
    ),
    ["11.a", "12"],
  );
});

test("eScribe browser downloads use the agenda route instead of the calendar detail route", () => {
  assert.equal(
    canonicalEscribeMeetingPageUrl("https://pub-owensound.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=abc&foo=ignored"),
    "https://pub-owensound.escribemeetings.com/Meeting.aspx?Id=abc&Agenda=Agenda&lang=English",
  );
  assert.equal(
    canonicalEscribeMeetingPageUrl("https://pub-owensound.escribemeetings.com/Meeting.aspx?Id=abc&Agenda=Agenda&lang=English"),
    "https://pub-owensound.escribemeetings.com/Meeting.aspx?Id=abc&Agenda=Agenda&lang=English",
  );
});

test("hybrid PDF keeps short scan fragments retryable unless the complete attachment is image-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyash-hybrid-image-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ps = path.join(root, "photo.ps");
  const pdf = path.join(root, "photo.pdf");
  fs.writeFileSync(ps, [
    "%!PS",
    "newpath 72 72 moveto 72 72 lineto 360 72 lineto 360 360 lineto 72 360 lineto closepath fill",
    "showpage",
  ].join("\n"), "utf8");
  execFileSync("ps2pdf", [ps, pdf]);
  const priorFixture = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({ 1: "G" });
  t.after(() => {
    if (priorFixture === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = priorFixture;
  });
  await assert.rejects(() => extractHybridPdfText({ pdfPath: pdf }), /no usable transcription/u);
  const result = await extractHybridPdfText({ pdfPath: pdf, allowImageOnly: true });
  assert.equal(result.text, "");
  assert.deepEqual(result.unusableScannedPages.map((entry) => entry.page), [1]);

  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({ 1: "[[IMAGE ONLY PAGE]]" });
  const classified = await extractHybridPdfText({ pdfPath: pdf });
  assert.equal(classified.text, "");
  assert.deepEqual(classified.imageOnlyPages, [1]);
});

test("hybrid PDF accepts a repeated two-word scan transcription as verified page text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyash-hybrid-short-ocr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, "slide.png");
  const pdf = path.join(root, "slide.pdf");
  execFileSync("convert", ["-size", "800x500", "xc:white", "-fill", "black", "-pointsize", "72", "-gravity", "center", "-draw", "text 0,0 'Thank You'", image]);
  const ppm = execFileSync("pngtopnm", [image], { maxBuffer: 8 * 1024 * 1024 });
  const ps = execFileSync("pnmtops", [], { input: ppm, maxBuffer: 8 * 1024 * 1024 });
  execFileSync("ps2pdf", ["-", pdf], { input: ps });
  const priorFixture = process.env.PDF_OCR_QWEN_FIXTURE;
  process.env.PDF_OCR_QWEN_FIXTURE = JSON.stringify({ 1: { responses: ["Thank You", "Thank You"] } });
  t.after(() => {
    if (priorFixture === undefined) delete process.env.PDF_OCR_QWEN_FIXTURE;
    else process.env.PDF_OCR_QWEN_FIXTURE = priorFixture;
  });
  const result = await extractHybridPdfText({ pdfPath: pdf });
  assert.equal(result.text, "Thank You");
  assert.deepEqual(result.verifiedShortOcrPages, [1]);
});

test("hybrid PDF treats zero-padded printed page numbers as pagination", () => {
  assert.equal(isPaginationOnlyPageText("005", 5, 87), true);
  assert.equal(isPaginationOnlyPageText("087", 87, 87), true);
  assert.equal(isPaginationOnlyPageText("005", 6, 87), false);
});

test("structured HTML still builds canonical bundles when a PDF response is not a PDF", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyash-escribe-response-"));
  const challenge = "<!doctype html><title>challenge</title><p>enable javascript</p>";
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(challenge);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const agendaMd = path.join(root, "agenda.md");
  const agendaHtml = path.join(root, "agenda.html");
  const outputDir = path.join(root, "subreports");
  const indexPath = path.join(root, "index.json");
  fs.writeFileSync(agendaMd, "CALL TO ORDER\n\nADJOURNMENT\n", "utf8");
  fs.writeFileSync(agendaHtml, [
    '<div class="AgendaItem AgendaItem11">',
    '<div class="AgendaItemCounter">8.a</div>',
    '<div class="AgendaItemTitle"><a tabindex="0">Harrison Park Marker Tree</a></div>',
    `<div class="AgendaItemAttachment AgendaItemAttachment11"><a href="http://127.0.0.1:${port}/challenge.pdf"><span>Marker Tree report.pdf</span></a></div>`,
    '</div>',
  ].join("\n"), "utf8");

  await runNode([
    GREY_EXTRACTOR,
    agendaMd,
    outputDir,
    indexPath,
    agendaHtml,
    "https://example.test/meeting",
  ], process.cwd());

  const [item] = JSON.parse(fs.readFileSync(indexPath, "utf8")).items;

  assert.equal(item.attachment_diagnostics[0].status, "response_not_pdf");
  assert.equal(item.extraction_method, "direct_attachments");
  assert.equal(item.has_page_slice, false);
  assert.ok(item.file);
  assert.match(fs.readFileSync(item.file, "utf8"), /Harrison Park Marker Tree/u);
});

test("structured HTML remains usable when the agenda package conversion is empty", { skip: !fs.existsSync(OWEN_PREPARER) }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyash-escribe-html-only-"));
  const convertedDir = path.join(root, "converted");
  const subreportDir = path.join(convertedDir, "subreports");
  const indexPath = path.join(convertedDir, "subreports.index.json");
  const agendaHtml = path.join(root, "agenda.html");
  fs.mkdirSync(convertedDir, { recursive: true });
  fs.writeFileSync(agendaHtml, [
    '<div class="AgendaItem AgendaItem11">',
    '<div class="AgendaItemCounter">8.a</div>',
    '<div class="AgendaItemTitle"><a tabindex="0">Harrison Park Marker Tree</a></div>',
    '</div>',
  ].join("\n"), "utf8");

  await runNode([
    path.join(MAIN_ROOT, "command/prepare_agenda_subreports_from_converted.mjs"),
    convertedDir,
    subreportDir,
    indexPath,
    OWEN_PREPARER,
    agendaHtml,
    "https://example.test/meeting",
  ], process.cwd());

  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.authoritative_source, agendaHtml);
  assert.deepEqual(index.items.map((item) => item.item), ["8.a"]);
  assert.match(fs.readFileSync(index.items[0].file, "utf8"), /Harrison Park Marker Tree/u);
});

test("structured eScribe evidence carries parent roles and attachment ownership to child items", () => {
  const evidence = buildCanonicalAgendaEvidence([
    { item: "6", title: "PUBLIC MEETINGS", attachments: [] },
    {
      item: "6.a",
      title: "Zoning By-law Amendment No. 59",
      attachments: [{ label: "Planning Presentation - Public Meeting - ZBA No. 59.pdf" }],
    },
  ]);
  assert.deepEqual(evidence.get("6.a"), [
    "PUBLIC MEETINGS",
    "Zoning By-law Amendment No. 59",
    "Planning Presentation - Public Meeting - ZBA No. 59.pdf",
  ]);
});
