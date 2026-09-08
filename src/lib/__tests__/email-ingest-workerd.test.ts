import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

const ROUTE_CONTENT_CAP = 100_000;
const TRUNCATION_MARKER = "\n\n[Email body truncated]";
const UNDER_CAP_LENGTH = 98_599;
const UNDER_CAP_NEWLINE_COUNT = 3_398;

type Fixture = {
  id: string;
  value: string;
};

type WorkerdDiagnostic = {
  id: string;
  inputLength: number;
  rawPayloadLength: number;
  rawValue: string;
  parsedValue: string;
  accepted: boolean;
  receiverStatus: number;
};

const underCapMultiline =
  "x\n".repeat(UNDER_CAP_NEWLINE_COUNT) +
  "x".repeat(UNDER_CAP_LENGTH - UNDER_CAP_NEWLINE_COUNT * 2);

const FIXTURES: Fixture[] = [
  { id: "lone-lf", value: "a\nb" },
  { id: "lone-cr", value: "a\rb" },
  { id: "crlf", value: "a\r\nb" },
  { id: "truncation-marker", value: TRUNCATION_MARKER },
  {
    id: "truncated-boundary",
    value: `${"x".repeat(ROUTE_CONTENT_CAP - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
  },
  { id: "under-cap-multiline", value: underCapMultiline },
];

function readWorkerRuntimeConfig(): {
  compatibilityDate: string;
  compatibilityFlags: string[];
} {
  const config = readFileSync(
    new URL("../../../workers/email-ingest/wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const dateMatches = [...config.matchAll(/"compatibility_date"\s*:\s*"([^"]+)"/g)];
  if (dateMatches.length !== 1) {
    throw new Error(
      `email-ingest workerd proof expected one compatibility_date, found ${dateMatches.length}`,
    );
  }

  const flagMatches = [...config.matchAll(/"compatibility_flags"\s*:\s*(\[[^\]]*\])/g)];
  if (flagMatches.length !== 1) {
    throw new Error(
      `email-ingest workerd proof expected one compatibility_flags array, found ${flagMatches.length}`,
    );
  }

  const parsedFlags: unknown = JSON.parse(flagMatches[0][1]);
  if (!Array.isArray(parsedFlags) || parsedFlags.some((flag) => typeof flag !== "string")) {
    throw new Error("email-ingest compatibility_flags must be an array of strings");
  }

  return {
    compatibilityDate: dateMatches[0][1],
    compatibilityFlags: parsedFlags,
  };
}

const RECEIVER_WORKER_SCRIPT = `
function rawContentValue(request, rawPayload) {
  const contentType = request.headers.get("content-type") || "";
  const boundaryMatch = /(?:^|;)\\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) throw new Error("multipart request omitted its boundary");
  const boundary = boundaryMatch[1] || boundaryMatch[2].trim();

  const disposition = 'Content-Disposition: form-data; name="content"';
  const dispositionStart = rawPayload.indexOf(disposition);
  if (dispositionStart < 0) throw new Error("raw payload omitted the content disposition");
  const valueStartMarker = "\\r\\n\\r\\n";
  const valueStart = rawPayload.indexOf(valueStartMarker, dispositionStart);
  if (valueStart < 0) throw new Error("raw payload omitted the content header terminator");
  const contentStart = valueStart + valueStartMarker.length;
  const contentEnd = rawPayload.indexOf("\\r\\n--" + boundary, contentStart);
  if (contentEnd < 0) throw new Error("raw payload omitted the closing boundary");
  return rawPayload.slice(contentStart, contentEnd);
}

export default {
  async fetch(request) {
    const rawPayload = await request.clone().text();
    const rawValue = rawContentValue(request, rawPayload);
    const parsed = await request.formData();
    const parsedValue = parsed.get("content");
    if (typeof parsedValue !== "string") {
      throw new Error("parsed content field was not a string");
    }
    const accepted = parsedValue.length <= ${ROUTE_CONTENT_CAP};
    return Response.json(
      { accepted, rawPayloadLength: rawPayload.length, rawValue, parsedValue },
      { status: accepted ? 200 : 400 },
    );
  },
};
`;

const PRODUCER_WORKER_SCRIPT = `
const fixtures = ${JSON.stringify(FIXTURES)};

export default {
  async fetch(_request, env) {
    const diagnostics = [];
    for (const fixture of fixtures) {
      const form = new FormData();
      form.append("from", "sender@example.com");
      form.append("to", "ingest@workwiki.app");
      form.append("subject", "Multipart runtime proof");
      form.append("messageId", "multipart-runtime-proof@example.com");
      form.append("content", fixture.value);
      form.append("skippedAttachmentCount", "0");
      const response = await env.YOPEDIA.fetch(
        new Request("https://workwiki.invalid/api/email/ingest", {
          method: "POST",
          headers: { Authorization: "Bearer runtime-proof-token" },
          body: form,
        }),
      );
      const receiver = await response.json();
      diagnostics.push({
        id: fixture.id,
        inputLength: fixture.value.length,
        receiverStatus: response.status,
        ...receiver,
      });
    }
    return Response.json({ diagnostics });
  },
};
`;

async function nodeParsedValue(value: string): Promise<string> {
  const form = new FormData();
  form.append("content", value);
  const request = new Request("https://workwiki.invalid/api/email/ingest", {
    method: "POST",
    body: form,
  });
  const parsed = await request.formData();
  const content = parsed.get("content");
  if (typeof content !== "string") throw new Error("Node parsed content field was not a string");
  return content;
}

function diagnostic(
  diagnostics: WorkerdDiagnostic[],
  id: string,
): WorkerdDiagnostic {
  const value = diagnostics.find((entry) => entry.id === id);
  if (!value) throw new Error(`workerd returned no diagnostic for ${id}`);
  return value;
}

function isUnsupportedFutureDateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_FUTURE_COMPATIBILITY_DATE"
  );
}

describe("email-ingest multipart transport in locally pinned workerd", () => {
  it("preserves every fixture across the local configured workerd service binding", async () => {
    const { compatibilityDate, compatibilityFlags } = readWorkerRuntimeConfig();
    let runtime: Miniflare | undefined;
    let primaryFailed = false;
    try {
      runtime = new Miniflare({
        workers: [
          {
            config: {
              name: "email-ingest-multipart-producer",
              type: "worker",
              compatibilityDate,
              compatibilityFlags,
              env: {
                YOPEDIA: {
                  type: "worker",
                  worker: "email-ingest-multipart-receiver",
                },
              },
              manifest: {
                mainModule: "producer.mjs",
                modules: {
                  "producer.mjs": { type: "esm", contents: PRODUCER_WORKER_SCRIPT },
                },
              },
            },
          },
          {
            config: {
              name: "email-ingest-multipart-receiver",
              type: "worker",
              compatibilityDate,
              compatibilityFlags,
              manifest: {
                mainModule: "receiver.mjs",
                modules: {
                  "receiver.mjs": { type: "esm", contents: RECEIVER_WORKER_SCRIPT },
                },
              },
            },
          },
        ],
      });
      const response = await runtime.dispatchFetch("https://workwiki.invalid/probe");
      const responseText = await response.text();
      expect(response.status, responseText).toBe(200);
      const payload = JSON.parse(responseText) as { diagnostics: WorkerdDiagnostic[] };
      expect(payload.diagnostics).toHaveLength(FIXTURES.length);

      for (const fixture of FIXTURES) {
        const result = diagnostic(payload.diagnostics, fixture.id);
        expect(result.inputLength).toBe(fixture.value.length);
        expect(result.rawPayloadLength).toBeGreaterThan(result.inputLength);
        expect(result.receiverStatus).toBe(200);
        expect(result.accepted).toBe(true);
        expect(result.rawValue).toBe(fixture.value);
        expect(result.parsedValue).toBe(fixture.value);
        expect(result.rawValue).toBe(result.parsedValue);
      }

      const boundary = diagnostic(payload.diagnostics, "truncated-boundary");
      expect(boundary.parsedValue).toHaveLength(ROUTE_CONTENT_CAP);
      expect(boundary.parsedValue.endsWith(TRUNCATION_MARKER)).toBe(true);

      const underCap = diagnostic(payload.diagnostics, "under-cap-multiline");
      expect(underCap.parsedValue).toHaveLength(UNDER_CAP_LENGTH);
      expect(underCap.parsedValue.match(/\n/g)).toHaveLength(UNDER_CAP_NEWLINE_COUNT);
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      try {
        await runtime?.dispose();
      } catch (error) {
        if (!primaryFailed) throw error;
      }
    }
  }, 30_000);

  it("rejects an unsupported future compatibility date instead of falling back", async () => {
    const { compatibilityFlags } = readWorkerRuntimeConfig();
    let runtime: Miniflare | undefined;
    try {
      const startupOrDispatch = (async () => {
        runtime = new Miniflare({
          workers: [
            {
              config: {
                name: "email-ingest-runtime-drift-probe",
                type: "worker",
                compatibilityDate: "9999-12-31",
                compatibilityFlags,
                manifest: {
                  mainModule: "probe.mjs",
                  modules: {
                    "probe.mjs": {
                      type: "esm",
                      contents:
                        'export default { fetch() { return new Response("unexpected fallback"); } };',
                    },
                  },
                },
              },
            },
          ],
        });
        await runtime.dispatchFetch("https://workwiki.invalid/probe");
      })();

      await expect(startupOrDispatch).rejects.toMatchObject({
        code: "ERR_FUTURE_COMPATIBILITY_DATE",
        message: expect.stringContaining('Compatibility date "9999-12-31"'),
      });
    } finally {
      try {
        await runtime?.dispose();
      } catch (error) {
        if (!isUnsupportedFutureDateError(error)) throw error;
      }
    }
  });

  it("keeps Node as a negative control for the same fixtures", async () => {
    const nodeValues = new Map<string, string>();
    for (const fixture of FIXTURES) {
      nodeValues.set(fixture.id, await nodeParsedValue(fixture.value));
    }

    expect(nodeValues.get("lone-lf")).toBe("a\r\nb");
    expect(nodeValues.get("lone-cr")).toBe("a\r\nb");
    expect(nodeValues.get("crlf")).toBe("a\r\nb");
    expect(nodeValues.get("truncation-marker")).toHaveLength(TRUNCATION_MARKER.length + 2);
    expect(nodeValues.get("truncated-boundary")).toBe(
      FIXTURES.find((fixture) => fixture.id === "truncated-boundary")!.value.replace(
        /\r\n|\r|\n/g,
        "\r\n",
      ),
    );
    expect(nodeValues.get("truncated-boundary")).toHaveLength(ROUTE_CONTENT_CAP + 2);
    expect(nodeValues.get("under-cap-multiline")).toBe(underCapMultiline.replace(/\n/g, "\r\n"));
    expect(nodeValues.get("under-cap-multiline")).toHaveLength(101_997);
    expect(nodeValues.get("under-cap-multiline")!.length).toBeGreaterThan(ROUTE_CONTENT_CAP);
  });
});
