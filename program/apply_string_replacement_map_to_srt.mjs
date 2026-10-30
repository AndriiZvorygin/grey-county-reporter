import fs from "node:fs";
import path from "node:path";

function usage() {
  return "Usage: node program/apply_string_replacement_map_to_srt.mjs <input.srt> <normalize.metadata.json> <output.srt>";
}

function ensureFile(p, label) {
  if (!p || !fs.existsSync(p)) throw new Error(`${label} not found: ${p || "(empty)"}`);
}

function loadReplacementMap(metaPath) {
  const json = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const map = json?.string_replacement_map;
  if (!map || typeof map !== "object") return [];
  return Object.entries(map)
    .filter(([from, to]) => typeof from === "string" && from && typeof to === "string")
    .sort((a, b) => b[0].length - a[0].length);
}

function isCueIndexLine(line) {
  return /^\d+\s*$/u.test(line);
}

function isTimeLine(line) {
  return /-->/u.test(line);
}

function applyReplacements(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) {
    if (!from || from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

function main() {
  const [inputPath, metaPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !metaPath || !outputPath) {
    console.error(usage());
    process.exit(2);
  }
  ensureFile(inputPath, "input srt");
  ensureFile(metaPath, "normalize metadata");
  const replacements = loadReplacementMap(metaPath);
  const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/u);
  const outLines = lines.map((line) => {
    if (!line || isCueIndexLine(line) || isTimeLine(line)) return line;
    return applyReplacements(line, replacements);
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${outLines.join("\n")}\n`, "utf8");
  console.log(outputPath);
}

main();
