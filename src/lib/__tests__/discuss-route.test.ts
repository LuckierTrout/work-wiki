import { describe, it, expect } from "vitest";
import { GET as listThreads, POST as createThread } from "@/app/api/wiki/[slug]/discuss/route";
import {
  GET as readThread,
  PATCH as patchThread,
} from "@/app/api/wiki/[slug]/discuss/[threadIndex]/route";
import { POST as addComment } from "@/app/api/wiki/[slug]/discuss/[threadIndex]/comments/route";

/**
 * Talk is retired (AD-21): every discuss handler answers a bodiless 404, for
 * readers and writers alike, with no thread read or write.
 */
describe("/api/wiki/[slug]/discuss/** — retired", () => {
  const handlers: [string, () => Response][] = [
    ["GET /discuss", listThreads],
    ["POST /discuss", createThread],
    ["GET /discuss/[threadIndex]", readThread],
    ["PATCH /discuss/[threadIndex]", patchThread],
    ["POST /discuss/[threadIndex]/comments", addComment],
  ];

  for (const [name, handler] of handlers) {
    it(`${name} 404s with no body`, async () => {
      const res = handler();
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });
  }
});
