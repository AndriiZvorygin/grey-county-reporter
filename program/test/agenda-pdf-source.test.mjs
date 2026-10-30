import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePdfSource, isPdfFile } from "../ensure-agenda-markdown-from-pdf.mjs";

function tempPdfPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-pdf-source-"));
  return { dir, pdfPath: path.join(dir, "agenda.pdf") };
}

test("Cloudflare HTML under an eScribe PDF URL is retried in the browser", async () => {
  const { dir, pdfPath } = tempPdfPath();
  fs.writeFileSync(pdfPath, "<!doctype html><title>Just a moment...</title>", "utf8");
  const browserState = { browser: null, page: null, pageUrl: "" };
  let request;
  const result = await ensurePdfSource({
    sourcePdf: pdfPath,
    sourceUrl: "https://pub-grey.escribemeetings.com/filestream.ashx?documentId=42",
    meetingPageUrl: "https://pub-grey.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=42",
    browserState,
    downloadPdf: async (args) => {
      request = args;
      fs.writeFileSync(args.pdfPath, "%PDF-1.7\nfixture", "ascii");
    },
  });

  assert.deepEqual(result, { isPdf: true, attemptedBrowser: true, error: "" });
  assert.equal(isPdfFile(pdfPath), true);
  assert.equal(request.pageUrl, "https://pub-grey.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=42");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failed browser retry leaves non-PDF package optional and reportable", async () => {
  const { dir, pdfPath } = tempPdfPath();
  fs.writeFileSync(pdfPath, "<!doctype html><title>Just a moment...</title>", "utf8");
  const result = await ensurePdfSource({
    sourcePdf: pdfPath,
    sourceUrl: "https://pub-grey.escribemeetings.com/filestream.ashx?documentId=42",
    downloadPdf: async () => { throw new Error("browser_response_not_pdf:text/html"); },
  });

  assert.deepEqual(result, {
    isPdf: false,
    attemptedBrowser: true,
    error: "browser_response_not_pdf:text/html",
  });
  assert.equal(isPdfFile(pdfPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("real PDF inputs do not start a browser retry", async () => {
  const { dir, pdfPath } = tempPdfPath();
  fs.writeFileSync(pdfPath, "%PDF-1.4\nfixture", "ascii");
  const result = await ensurePdfSource({
    sourcePdf: pdfPath,
    sourceUrl: "https://pub-grey.escribemeetings.com/filestream.ashx?documentId=42",
    downloadPdf: async () => { throw new Error("must not be called"); },
  });

  assert.deepEqual(result, { isPdf: true, attemptedBrowser: false, error: "" });
  fs.rmSync(dir, { recursive: true, force: true });
});
