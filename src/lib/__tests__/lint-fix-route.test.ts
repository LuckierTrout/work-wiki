import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }));

import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIsOwner = vi.mocked(isOwnerHandle);

/**
 * `POST /api/lint/fix` — the HTTP answer for a non-fixable issue type.
 *
 * `lint-fix.test.ts` pins that `fixLintIssue("disputed-page", …)` throws a
 * `FixValidationError` carrying the owner action. What only this file can
 * observe is that the route TRANSLATES that throw into a 400 whose body still
 * carries the message: the route catches `FixValidationError` before its
 * generic handler, and a reordered or removed catch would turn the same throw
 * into a 500 with `getErrorMessage(error)` — the button-less UI would keep
 * working, and the one surface that tells an owner how to clear the flag would
 * be gone from the wire.
 *
 * `fixLintIssue` is deliberately NOT mocked. Mocking it would leave the real
 * dispatcher's `disputed-page` branch untested from here, and the pairing of a
 * specific error CLASS with a specific status is exactly what would break.
 */
async function postFix(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/lint/fix/route");
  return POST(
    new Request("http://localhost/api/lint/fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user_1", handle: "LuckierTrout" });
  mockedIsOwner.mockReturnValue(true);
});

describe("POST /api/lint/fix — disputed-page", () => {
  it("answers 400 with the owner clear path", async () => {
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("cannot be auto-fixed");
    expect(body.error).toContain(
      "PATCH /api/wiki/contested-page with metadata { disputed: false }",
    );
  });

  it("does not fall through to the generic unsupported-type message", async () => {
    // The `disputed-page` branch is explicit precisely so the response names
    // the human action. Falling through to `default:` would also produce a 400,
    // so the status alone cannot tell the two apart.
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });
    const body = (await res.json()) as { error?: string };

    expect(body.error).not.toContain("Auto-fix not supported for this issue type");
  });

  it("still gates on ownership before reaching the dispatcher", async () => {
    mockedIsOwner.mockReturnValue(false);

    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(403);
  });
});

/**
 * A read-only deployment refuses a lint fix (DW-187).
 *
 * This door keeps a route-level gate for the rule's SECOND half only:
 * `fixContradiction` and `fixMissingConceptPage` each run a `callLLM` rewrite
 * before touching the page, so a kernel-only refusal would pay for a model call
 * whose output is thrown away — and an LLM failure would answer 500 in place of
 * the refusal.
 *
 * `fixLintIssue` stays unmocked here, as it is above: what is being pinned is
 * that the route never reaches the real dispatcher at all, which a mock would
 * make unfalsifiable.
 */
describe("POST /api/lint/fix — read-only deployment", () => {
  let originalReadOnly: string | undefined;

  beforeEach(() => {
    originalReadOnly = process.env.YOPEDIA_READONLY;
    delete process.env.YOPEDIA_READONLY;
  });

  afterEach(() => {
    if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = originalReadOnly;
  });

  it("answers 403 before the fix dispatcher runs", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const res = await postFix({ type: "orphan-page", slug: "some-page" });

    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "read-only",
    );
  });

  it("refuses an LLM-backed fix with the SAME answer, not a model failure", async () => {
    // The door's whole reason for keeping a route gate. Un-gated, this case
    // reaches `callLLM` with no key configured and answers 400/500 about the
    // model — a refusal the owner would read as a broken integration.
    process.env.YOPEDIA_READONLY = "1";

    const res = await postFix({
      type: "contradiction",
      slug: "page-a",
      targetSlug: "page-b",
      message: "they disagree",
    });

    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "read-only",
    );
  });

  it("still answers 403-Forbidden to a non-owner, before the read-only gate", async () => {
    // Ordering: the owner gate stays first, so a signed-out caller is not told
    // about the deployment's write posture.
    mockedIsOwner.mockReturnValue(false);
    process.env.YOPEDIA_READONLY = "1";

    const res = await postFix({ type: "orphan-page", slug: "some-page" });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe("Forbidden");
  });

  it("reaches the dispatcher as before with the flag unset — the control case", async () => {
    // `disputed-page` is the branch the file already pins: a real dispatcher
    // answer, which proves the new gate did not swallow the request.
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain(
      "cannot be auto-fixed",
    );
  });
});
