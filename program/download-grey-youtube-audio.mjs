#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [, , urlArg, outputArg] = process.argv;
const url = String(urlArg || "").trim();
const outputPath = path.resolve(String(outputArg || ""));

if (!/^https:\/\/(?:www\.)?youtube\.com\/watch\?/iu.test(url)) {
  throw new Error(`official YouTube recording URL is invalid: ${url}`);
}
if (!outputArg) throw new Error("output path is required");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
let result = null;
for (const playerClient of ["android_vr", "android"]) {
  result = spawnSync("yt-dlp", [
    "--extractor-args",
    `youtube:player_client=${playerClient}`,
    "--no-playlist",
    "--force-overwrites",
    "-x",
    "--audio-format",
    "opus",
    "-o",
    outputPath,
    url,
  ], {
    encoding: "utf8",
    stdio: "inherit",
    timeout: 60 * 60 * 1000,
  });
  if (!result.error && result.status === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size >= 1024) break;
}

if (result?.error) throw result.error;
if (result?.status !== 0) throw new Error(`yt-dlp exited ${result?.status}`);
if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
  throw new Error(`yt-dlp completed without usable audio: ${outputPath}`);
}
