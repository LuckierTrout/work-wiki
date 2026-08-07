import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type SandboxWorkerEnv = Cloudflare.Env & {
  // Secrets are intentionally absent from generated Wrangler binding types.
  YOPEDIA_SANDBOX_TOKEN: string;
};

interface ExecuteBody {
  runId?: unknown;
  command?: unknown;
  files?: unknown;
  outputFiles?: unknown;
  timeoutMs?: unknown;
}

function safeRunId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{8,80}$/i.test(value) ? value : null;
}

function safeFiles(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return null;
  const result: Record<string, string> = {};
  let total = 0;
  for (const [name, content] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name) || typeof content !== "string") return null;
    total += new TextEncoder().encode(content).byteLength;
    if (total > 2_000_000) return null;
    result[name] = content;
  }
  return result;
}

function safeOutputFiles(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const files = value.filter((name): name is string =>
    typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name));
  return files.length === value.length ? [...new Set(files)] : null;
}

function mediaType(filename: string): string {
  if (/\.md$/i.test(filename)) return "text/markdown";
  if (/\.csv$/i.test(filename)) return "text/csv";
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.html?$/i.test(filename)) return "text/html";
  if (/\.svg$/i.test(filename)) return "image/svg+xml";
  return "text/plain";
}

async function bearerMatches(value: string | null, secret: string): Promise<boolean> {
  const actual = value?.startsWith("Bearer ") ? value.slice(7) : "";
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = actual.length === secret.length ? 0 : 1;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export default {
  async fetch(request: Request, env: SandboxWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (
      request.method !== "POST" ||
      url.pathname !== "/execute" ||
      !(await bearerMatches(request.headers.get("Authorization"), env.YOPEDIA_SANDBOX_TOKEN))
    ) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const declaredBytes = Number(request.headers.get("X-Yopedia-Payload-Bytes"));
    if (!Number.isFinite(declaredBytes) || declaredBytes < 2 || declaredBytes > 2_100_000) {
      return Response.json({ error: "Invalid execution payload size" }, { status: 413 });
    }
    const body = await request.json().catch(() => null) as ExecuteBody | null;
    const runId = safeRunId(body?.runId);
    const command = typeof body?.command === "string" ? body.command.trim() : "";
    const files = safeFiles(body?.files);
    const outputFiles = safeOutputFiles(body?.outputFiles);
    const timeoutMs = typeof body?.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
      ? Math.max(1_000, Math.min(120_000, Math.floor(body.timeoutMs)))
      : 30_000;
    if (!runId || !command || command.length > 4_000 || !files || !outputFiles) {
      return Response.json({ error: "Invalid execution request" }, { status: 400 });
    }

    try {
      const sandbox = getSandbox(env.Sandbox, `run-${runId}`, {
        sleepAfter: "10m",
        enableDefaultSession: false,
      });
      for (const [name, content] of Object.entries(files)) {
        await sandbox.writeFile(`/workspace/${name}`, content);
      }
      const result = await sandbox.exec(command, { cwd: "/workspace", timeout: timeoutMs });
      const artifacts: Array<{ filename: string; content: string; mediaType: string }> = [];
      let artifactBytes = 0;
      for (const filename of outputFiles) {
        try {
          const file = await sandbox.readFile(`/workspace/${filename}`, { encoding: "utf8" });
          if (!file.success) continue;
          artifactBytes += new TextEncoder().encode(file.content).byteLength;
          if (artifactBytes > 2_000_000) break;
          artifacts.push({ filename, content: file.content.slice(0, 500_000), mediaType: mediaType(filename) });
        } catch { /* Missing output is reported by omission, not a failed command. */ }
      }
      return Response.json({
        stdout: result.stdout.slice(0, 200_000),
        stderr: result.stderr.slice(0, 100_000),
        exitCode: result.exitCode,
        artifacts,
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "sandbox execution failed",
        runId,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "unknown error",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message.slice(0, 2_000) : "Sandbox execution failed" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<SandboxWorkerEnv>;
