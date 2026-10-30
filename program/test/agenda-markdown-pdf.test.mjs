import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "ensure-agenda-markdown-from-pdf.mjs");

test("agenda markdown conversion skips an HTML challenge saved as a PDF", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pyash-agenda-pdf-"));
  const source = path.join(root, "agenda.pdf");
  const output = path.join(root, "agenda.md");
  fs.writeFileSync(source, "<!doctype html><title>Just a moment...</title>", "utf8");

  const result = spawnSync(process.execPath, [script, source, output], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not a PDF; skipping optional package conversion/u);
  assert.equal(fs.existsSync(output), false);
  fs.rmSync(root, { recursive: true, force: true });
});
