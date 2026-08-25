/**
 * The sidecar's half of the extract path (Stories 7.1–7.4).
 *
 * The kernel half is pinned in `extract-jobs.test.ts`; this is the poller that
 * claims those records. Everything below drives the real module with injected
 * dependencies — no child process, no network — because the behaviours worth
 * pinning are about SEQUENCE and FAILURE REPORTING, not about Rust: claim
 * before parse, complete only with text, and a failure that reaches the owner
 * as a sentence rather than an exit code.
 *
 * IT IMPORTS FROM `sidecar/`, WHICH IMPORTS NOTHING FROM `src/lib`. The arrow
 * points one way on purpose (the sidecar must stay loadable as a plain Node
 * process), and a test reaching across it does not reverse it. The last case
 * here asserts that.
 */
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  EXTRACT_BINARY_MISSING_COPY,
  drainOnce,
  extractOne,
  parseBinaryOutput,
  resolveExtractConfig,
  safeName,
} from "../../../sidecar/extract-loop.mjs";

const CONFIG = { base: "https://wiki.example", token: "t", cacheDir: "/tmp/cache" };

const JOB = {
  extractId: "extract-1",
  owner: "alice",
  filename: "quarterly-plan.pdf",
  format: "pdf",
  bytesSha256: "ab".repeat(32),
  size: 12,
};

/**
 * A `fetch` that answers the three kernel doors the loop talks to and records
 * every POST body, so a test can assert the ORDER of the verbs.
 */
function kernel(options: {
  jobs?: unknown[];
  settings?: unknown;
  claim?: (body: Record<string, unknown>) => { status: number; body: unknown };
} = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.includes("/api/extract/settings")) {
      return json(200, options.settings ?? { mineru: { mode: "off" } });
    }
    if (url.includes("/api/extract/jobs") && !init?.method) {
      return json(200, { owner: "alice", jobs: options.jobs ?? [JOB] });
    }
    if (body?.action === "claim") {
      const answer = options.claim?.(body) ?? { status: 200, body: { ...JOB } };
      return json(answer.status, answer.body);
    }
    return json(200, { ok: true });
  });
  return { calls, fetchMock };
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Verb names in the order the loop sent them. */
function verbs(calls: Array<{ body: Record<string, unknown> | null }>): string[] {
  return calls.map((call) => String(call.body?.action ?? "")).filter(Boolean);
}

describe("the claim loop", () => {
  it("claims, parses, then completes — in that order", async () => {
    const { calls, fetchMock } = kernel();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const handled = await drainOnce(CONFIG, "/bin/extract");
      expect(handled).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    // The parse itself needs a real binary, so it fails here — which is the
    // point of this assertion: even then the record is answered, and the claim
    // came first. A loop that completed before claiming would let two pollers
    // both write text for one document.
    expect(verbs(calls)).toEqual(["claim", "fail"]);
  });

  it("skips a record another poller already claimed, without failing it", async () => {
    // 409 is the expected outcome of two pollers, not a fault. Answering it
    // with `fail` would let the loser mark the winner's document broken.
    const { calls, fetchMock } = kernel({
      claim: () => ({ status: 409, body: { claimed: false } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await drainOnce(CONFIG, "/bin/extract")).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(verbs(calls)).toEqual(["claim"]);
  });

  it("polls even with nothing to do — the poll is the heartbeat", async () => {
    const { calls, fetchMock } = kernel({ jobs: [] });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await drainOnce(CONFIG, "/bin/extract")).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    // One GET and nothing else: the kernel now knows a sidecar exists, which
    // is what keeps the arrival door from failing drops closed.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/extract/jobs");
    expect(calls[0].body).toBeNull();
  });

  it("names the missing binary instead of letting the kernel say the sidecar is down", async () => {
    // The sidecar IS up — it is this process. Telling the owner to start it
    // sends them after the wrong fix; the real one is a cargo build.
    const { calls, fetchMock } = kernel();
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await drainOnce(CONFIG, null)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(verbs(calls)).toEqual(["claim", "fail"]);
    expect(calls.at(-1)?.body?.error).toBe(EXTRACT_BINARY_MISSING_COPY);
  });
});

describe("extracting one document", () => {
  const deps = (runBinary: unknown, runMinerU?: unknown) => ({
    fetchBytes: async () => Buffer.from("bytes"),
    runBinary,
    ...(runMinerU ? { runMinerU } : {}),
  });

  it("returns the crate's markdown and reports a cache hit", async () => {
    const result = await extractOne(
      CONFIG,
      "/bin/extract",
      JOB,
      { mineru: { mode: "off" } },
      deps(async () => ({ ok: true, markdown: "# Plan", cacheHit: true })),
    );
    expect(result).toEqual({ markdown: "# Plan", cacheHit: true });
  });

  it("does not reach MinerU when it is off", async () => {
    // The default. A complex layout that the built-in pass could not read
    // fails VISIBLY rather than quietly uploading the document somewhere.
    const mineru = vi.fn();
    await expect(
      extractOne(
        CONFIG,
        "/bin/extract",
        JOB,
        { mineru: { mode: "off" } },
        deps(async () => ({ ok: false, error: "PDF has no text layer." }), mineru),
      ),
    ).rejects.toThrow("PDF has no text layer.");
    expect(mineru).not.toHaveBeenCalled();
  });

  it("escalates to MinerU only after the built-in pass ran and came back empty", async () => {
    const runBinary = vi.fn(async () => ({ ok: false, error: "PDF has no text layer." }));
    const mineru = vi.fn(async (_options: Record<string, unknown>) => "# From MinerU");
    const result = await extractOne(
      CONFIG,
      "/bin/extract",
      JOB,
      { mineru: { mode: "local", localBaseUrl: "http://127.0.0.1:8000" } },
      deps(runBinary, mineru),
    );
    expect(runBinary).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe("# From MinerU");
    expect(mineru.mock.calls[0][0]).toMatchObject({
      mode: "local",
      localBaseUrl: "http://127.0.0.1:8000",
    });
  });

  it("never escalates a non-PDF", async () => {
    const mineru = vi.fn();
    await expect(
      extractOne(
        CONFIG,
        "/bin/extract",
        { ...JOB, format: "docx", filename: "plan.docx" },
        { mineru: { mode: "local" } },
        deps(async () => ({ ok: false, error: "DOCX could not be read." }), mineru),
      ),
    ).rejects.toThrow("DOCX could not be read.");
    expect(mineru).not.toHaveBeenCalled();
  });

  it("reports BOTH failures when MinerU also fails", async () => {
    // Reporting only the MinerU error would hide that the built-in pass ran
    // and found nothing — the fact that explains why MinerU was consulted.
    await expect(
      extractOne(
        CONFIG,
        "/bin/extract",
        JOB,
        { mineru: { mode: "cloud", apiKey: "k" } },
        deps(
          async () => ({ ok: false, error: "PDF has no text layer." }),
          async () => {
            throw new Error("402 quota exhausted");
          },
        ),
      ),
    ).rejects.toThrow(/PDF has no text layer\..*MinerU also failed: 402 quota exhausted/);
  });

  it("treats empty MinerU output as a failure, not as a document", async () => {
    await expect(
      extractOne(
        CONFIG,
        "/bin/extract",
        JOB,
        { mineru: { mode: "local" } },
        deps(
          async () => ({ ok: false, error: "PDF has no text layer." }),
          async () => "   ",
        ),
      ),
    ).rejects.toThrow(/MinerU also failed/);
  });
});

describe("the details that keep the temp file a temp file", () => {
  it("keeps the extension and cannot escape the temp directory", () => {
    expect(safeName("plan.docx", "docx")).toBe("plan.docx");
    expect(safeName("../../etc/passwd", "pdf")).toBe("passwd.pdf");
    expect(safeName("", "pdf")).toBe("document.pdf");
    // A name with no usable extension still gets the claimed format's, because
    // the extension is what picks a parser inside the crate.
    expect(safeName("report", "xlsx")).toBe("report.xlsx");
    expect(safeName('a"; rm -rf x.pdf', "pdf")).toBe("a___rm_-rf_x.pdf");
    // A last segment that is all extension would be a dotfile; it gets a name.
    expect(safeName("/tmp/.pdf", "pdf")).toBe("pdf.pdf");
    expect(safeName("/tmp/...", "pdf")).toBe("document.pdf");
  });

  it("reads the crate's JSON even when a library printed noise first", () => {
    expect(parseBinaryOutput('warn: font\n{"ok":true,"markdown":"# A"}')).toEqual({
      ok: true,
      markdown: "# A",
    });
    expect(parseBinaryOutput("no json here")).toBeNull();
    expect(parseBinaryOutput("{not json}")).toBeNull();
  });
});

describe("credentials", () => {
  // `resolveExtractConfig` reads `process.env`, whose type demands NODE_ENV; a
  // test env is a bag of the two or three names under test and nothing else.
  const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

  it("accepts the frozen operator names and the kernel's own, and invents no third", () => {
    expect(
      resolveExtractConfig(env({ WORKWIKI_URL: "https://a/", WORKWIKI_API_TOKEN: "t" })),
    ).toMatchObject({ base: "https://a", token: "t", enabled: true });
    expect(
      resolveExtractConfig(env({ YOPEDIA_URL: "https://b", YOPEDIA_SERVICE_TOKEN: "s" })),
    ).toMatchObject({ base: "https://b", token: "s", enabled: true });
    // Half a credential is not a credential: the loop stays idle rather than
    // polling unauthenticated and reading 401 as "no work".
    expect(resolveExtractConfig(env({ WORKWIKI_URL: "https://a" })).enabled).toBe(false);
    expect(resolveExtractConfig(env({})).enabled).toBe(false);
  });
});

describe("the one-way import rule", () => {
  it("keeps every sidecar module free of src/lib", async () => {
    // The sidecar is a plain Node process on the owner's laptop; a single
    // `@/lib` import would make it depend on the Next build it is meant to
    // survive without. Asserted over the source, because a lint rule for a
    // directory outside `src/` is easy to configure away by accident.
    const root = path.resolve(__dirname, "../../../sidecar");
    for (const file of ["extract-loop.mjs", "mineru.mjs", "server.mjs"]) {
      const source = await readFile(path.join(root, file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^@\/|src\/lib/);
      }
    }
  });
});
