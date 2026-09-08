/**
 * MinerU, the OPTIONAL PDF escalation (Story 7.2).
 *
 * Default off, and never the first thing tried: the built-in `pdf-extract`
 * pass always runs, and MinerU is consulted only when that pass came back with
 * nothing — a scanned page, a two-column layout with no text layer, a form.
 * That ordering is the difference between "documents stay on this machine
 * unless the owner said otherwise" and a setting that quietly re-routes every
 * PDF the moment it is enabled.
 *
 * THREE MODES, and only one of them leaves the machine:
 *
 *   - `local` / `pipeline` POST the bytes to a MinerU API server the owner is
 *     running (`mineru-api --host 127.0.0.1 --port 8000`). `pipeline` is the
 *     same server with the pipeline backend rather than the VLM one.
 *   - `cloud` uploads to mineru.net: request a signed URL, PUT the file, poll
 *     the batch result, fetch the Markdown. This is what the orange warning in
 *     Settings is about, and it is why it cannot be the first mode offered.
 *
 * Lives in the sidecar, not the kernel, because the Worker has no document to
 * send: the bytes are on this machine and the local server is on loopback.
 */

const CLOUD_BASE = "https://mineru.net/api/v4";
const CLOUD_POLL_INTERVAL_MS = 3000;
const CLOUD_TIMEOUT_MS = 5 * 60 * 1000;
const LOCAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Modes that actually run something. `off` is handled by the caller. */
export const MINERU_ACTIVE_MODES = ["local", "pipeline", "cloud"];

export class MinerUError extends Error {}

/**
 * Run MinerU over one document and return Markdown.
 *
 * `bytes` is a `Uint8Array`/`Buffer` the claim loop already has in hand — the
 * caller has the temp file too, but the local server takes multipart and the
 * cloud takes a PUT body, and neither wants a path.
 */
export async function runMinerU({ mode, bytes, filename, localBaseUrl, apiKey, fetchImpl = fetch }) {
  if (mode === "cloud") {
    if (!apiKey) {
      throw new MinerUError("MinerU Cloud is selected but no API key is saved.");
    }
    return runCloud({ bytes, filename, apiKey, fetchImpl });
  }
  if (mode === "local" || mode === "pipeline") {
    return runLocal({ mode, bytes, filename, localBaseUrl, fetchImpl });
  }
  throw new MinerUError(`Unknown MinerU mode: ${mode}`);
}

/**
 * The Local API's synchronous door.
 *
 * `POST /file_parse` submits to the same task manager `POST /tasks` uses and
 * blocks until it finishes, which is what the claim loop wants: one request,
 * one answer, no second piece of state to reconcile if the sidecar restarts
 * mid-parse. `response_format_zip` is left off so the answer is JSON.
 */
async function runLocal({ mode, bytes, filename, localBaseUrl, fetchImpl }) {
  const base = (localBaseUrl || "http://127.0.0.1:8000").replace(/\/+$/, "");
  const form = new FormData();
  form.append("files", new Blob([bytes]), filename || "document.pdf");
  form.append("return_md", "true");
  if (mode === "pipeline") form.append("backend", "pipeline");

  const response = await fetchImpl(`${base}/file_parse`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
  }).catch((error) => {
    throw new MinerUError(`MinerU Local API is not reachable: ${error.message}`);
  });
  if (!response.ok) {
    throw new MinerUError(`MinerU Local API returned ${response.status}.`);
  }
  const payload = await response.json().catch(() => null);
  const markdown = firstMarkdown(payload);
  if (!markdown) {
    throw new MinerUError("MinerU Local API returned no Markdown.");
  }
  return markdown;
}

/**
 * Find the Markdown in a `/file_parse` answer.
 *
 * The server's shape has moved between releases (a `results` map keyed by
 * file name, a flat `md_content`, a list), so the value is looked for rather
 * than addressed. A reader that hard-coded one shape would fail on an upgrade
 * with "returned no Markdown" and send the owner hunting in the wrong place.
 */
export function firstMarkdown(payload, depth = 0) {
  if (typeof payload === "string") return payload.trim() || null;
  if (!payload || typeof payload !== "object" || depth > 6) return null;
  for (const key of ["md_content", "markdown", "md"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(payload)) {
    const found = firstMarkdown(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** mineru.net: signed upload URL → PUT → poll the batch → fetch the Markdown. */
async function runCloud({ bytes, filename, apiKey, fetchImpl }) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  const name = filename || "document.pdf";
  const applied = await fetchImpl(`${CLOUD_BASE}/file-urls/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      files: [{ name, data_id: "work-wiki" }],
      model_version: "vlm",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const applyBody = await applied.json().catch(() => null);
  if (!applied.ok || !applyBody || applyBody.code !== 0) {
    throw new MinerUError(
      `MinerU Cloud refused the upload: ${applyBody?.msg || applied.status}`,
    );
  }
  const batchId = applyBody.data?.batch_id;
  const uploadUrl = applyBody.data?.file_urls?.[0];
  if (!batchId || !uploadUrl) {
    throw new MinerUError("MinerU Cloud returned no upload URL.");
  }

  const uploaded = await fetchImpl(uploadUrl, {
    method: "PUT",
    body: bytes,
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });
  if (!uploaded.ok) {
    throw new MinerUError(`MinerU Cloud upload failed (${uploaded.status}).`);
  }

  // Uploading is the submission — there is no separate "start" call — so from
  // here it is only polling.
  const deadline = Date.now() + CLOUD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLOUD_POLL_INTERVAL_MS));
    const polled = await fetchImpl(
      `${CLOUD_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`,
      { headers, signal: AbortSignal.timeout(60_000) },
    );
    const body = await polled.json().catch(() => null);
    if (!polled.ok || !body) continue;
    const row = (body.data?.extract_result ?? []).find(
      (item) => item?.file_name === name,
    ) ?? body.data?.extract_result?.[0];
    if (!row) continue;
    if (row.state === "failed") {
      throw new MinerUError(
        `MinerU Cloud could not parse the document: ${row.err_msg || "unknown error"}`,
      );
    }
    if (row.state === "done") {
      const url = row.full_md_link || row.markdown_url;
      if (!url) throw new MinerUError("MinerU Cloud returned no Markdown link.");
      const text = await fetchImpl(url, {
        signal: AbortSignal.timeout(120_000),
      }).then((res) => (res.ok ? res.text() : ""));
      if (!text.trim()) {
        throw new MinerUError("MinerU Cloud returned an empty document.");
      }
      return text.trim();
    }
  }
  throw new MinerUError("MinerU Cloud timed out before the document was parsed.");
}
