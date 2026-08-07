export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  artifacts?: Array<{ filename: string; content: string; mediaType?: string }>;
}

interface SandboxServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

async function resolveSandboxTransport(): Promise<{
  endpoint: string;
  fetcher: typeof fetch;
  token: string;
}> {
  const token = process.env.YOPEDIA_SANDBOX_TOKEN?.trim();
  if (!token) {
    throw new Error("Sandbox execution is not configured. Set YOPEDIA_SANDBOX_TOKEN.");
  }
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = getCloudflareContext() as unknown as {
      env?: { YOPEDIA_SANDBOX?: SandboxServiceBinding };
    };
    const service = context.env?.YOPEDIA_SANDBOX;
    if (service) {
      return {
        endpoint: "https://yopedia-sandbox.internal/execute",
        fetcher: service.fetch.bind(service) as typeof fetch,
        token,
      };
    }
  } catch {
    // Local Next.js and tests do not expose Cloudflare bindings.
  }
  const base = process.env.YOPEDIA_SANDBOX_URL?.trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("Sandbox execution is not configured. Bind YOPEDIA_SANDBOX or set YOPEDIA_SANDBOX_URL.");
  }
  return { endpoint: `${base}/execute`, fetcher: fetch, token };
}

/** Call the separately deployed Cloudflare Sandbox worker through a signed API. */
export async function executeInSandbox(input: {
  runId: string;
  command: string;
  files?: Record<string, string>;
  outputFiles?: string[];
  timeoutMs?: number;
}): Promise<SandboxExecutionResult> {
  const transport = await resolveSandboxTransport();
  const payload = JSON.stringify({
    runId: input.runId,
    command: input.command.slice(0, 4_000),
    files: input.files ?? {},
    outputFiles: input.outputFiles ?? [],
    timeoutMs: Math.max(1_000, Math.min(120_000, input.timeoutMs ?? 30_000)),
  });
  const response = await transport.fetcher(transport.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transport.token}`,
      "Content-Type": "application/json",
      "X-Yopedia-Payload-Bytes": String(new TextEncoder().encode(payload).byteLength),
    },
    body: payload,
    signal: AbortSignal.timeout(Math.max(5_000, Math.min(130_000, (input.timeoutMs ?? 30_000) + 5_000))),
  });
  const body = await response.json().catch(() => null) as (SandboxExecutionResult & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || `Sandbox failed (${response.status})`);
  return body;
}
