import net from "node:net";

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

export function isLocalOllamaHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const hostname = String(parsed.hostname || "").toLowerCase().replace(/^\[|\]$/gu, "");
  if (LOCAL_HOSTNAMES.has(hostname) || hostname === "::1" || hostname === "0.0.0.0") return true;
  return net.isIP(hostname) === 4 && (hostname === "127.0.0.1" || hostname.startsWith("127."));
}

export function requireRemoteOllamaHost(value, { label = "Ollama host" } = {}) {
  const host = String(value || "").trim().replace(/\/+$/u, "");
  if (!host) throw new Error(`${label} is not configured; set the remote Ollama endpoint in configure/secret.pya`);
  let parsed;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error(`${label} is invalid: ${host}`);
  }
  if (!/^https?:$/iu.test(parsed.protocol)) {
    throw new Error(`${label} must use http or https: ${host}`);
  }
  if (isLocalOllamaHost(host)) {
    throw new Error(`${label} resolves to a local Ollama service (${host}); Grey County reporters require the configured remote GPU host`);
  }
  return host;
}
