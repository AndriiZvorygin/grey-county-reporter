import { collectArtifactStates } from "./artifact-contracts.mjs";

export function createStageRunner({
  log = () => {},
  force = false,
  writer = "",
  source = "",
  meetingId = "",
  runId = "",
} = {}) {
  const stageRuns = [];

  function resolveArtifacts(listOrFn) {
    if (typeof listOrFn === "function") {
      const out = listOrFn();
      return Array.isArray(out) ? out : [];
    }
    return Array.isArray(listOrFn) ? listOrFn : [];
  }

  async function runStage(name, fn, {
    skipWhen = null,
    optional = false,
    inputArtifacts = [],
    outputArtifacts = [],
    validationFlags = {},
    notes = "",
  } = {}) {
    const startedAt = new Date();
    const stageRecord = {
      writer,
      source,
      meeting_id: meetingId || "",
      run_id: runId || "",
      stage_name: name,
      status: "ok",
      started_at: startedAt.toISOString(),
      finished_at: startedAt.toISOString(),
      duration_ms: 0,
      input_artifacts: collectArtifactStates(resolveArtifacts(inputArtifacts)),
      output_artifacts: [],
      validation_flags: validationFlags && typeof validationFlags === "object" ? validationFlags : {},
      notes: notes || "",
    };

    if (!force && typeof skipWhen === "function" && skipWhen()) {
      log(`[full-pipeline] skip ${name} (checkpoint exists)`);
      stageRecord.status = "skipped";
      stageRecord.output_artifacts = collectArtifactStates(resolveArtifacts(outputArtifacts));
      stageRecord.finished_at = new Date().toISOString();
      stageRecord.duration_ms = Math.max(0, Date.now() - startedAt.getTime());
      stageRuns.push(stageRecord);
      return stageRecord;
    }

    log(`[full-pipeline] start ${name}`);
    const t0 = Date.now();
    try {
      const result = await fn();
      const ms = Date.now() - t0;
      log(`[full-pipeline] done ${name} in ${(ms / 1000).toFixed(1)}s`);
      stageRecord.status = "ok";
      stageRecord.duration_ms = ms;
      stageRecord.finished_at = new Date().toISOString();
      stageRecord.output_artifacts = collectArtifactStates(resolveArtifacts(outputArtifacts));
      if (result && typeof result === "object") {
        if (result.validation_flags && typeof result.validation_flags === "object") {
          stageRecord.validation_flags = { ...stageRecord.validation_flags, ...result.validation_flags };
        }
        if (typeof result.notes === "string" && result.notes.trim()) {
          stageRecord.notes = result.notes.trim();
        }
      }
      stageRuns.push(stageRecord);
      return stageRecord;
    } catch (err) {
      stageRecord.status = optional ? "warn" : "error";
      stageRecord.error = String(err?.message || err || "");
      stageRecord.finished_at = new Date().toISOString();
      stageRecord.duration_ms = Math.max(0, Date.now() - startedAt.getTime());
      stageRecord.output_artifacts = collectArtifactStates(resolveArtifacts(outputArtifacts));
      stageRuns.push(stageRecord);
      if (optional) {
        log(`[full-pipeline] warn ${name}: ${stageRecord.error}`);
        return stageRecord;
      }
      throw err;
    }
  }

  function getStageRuns() {
    return [...stageRuns];
  }

  return {
    runStage,
    getStageRuns,
  };
}
