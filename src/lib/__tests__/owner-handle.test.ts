/**
 * `owner.ts` — the resolver every owner gate is built on.
 *
 * Pinned here because the Wiki-creation gate (DW-159) and the Schema-edit gate
 * both spend `isOwnerHandle` and both MOCK it in their own route suites, so
 * nothing else in the repo asserts what the real function answers. The
 * load-bearing case is an UNSET `NEXT_PUBLIC_OWNER_HANDLE`: it must mean
 * "nobody is the owner", never "everybody is" — an unconfigured deployment has
 * to refuse creation, not open it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOwnerHandle, isOwnerHandle } from "../owner";

const saved = process.env.NEXT_PUBLIC_OWNER_HANDLE;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
});

afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = saved;
});

describe("getOwnerHandle", () => {
  it("answers null when unset, blank, or whitespace-only, and trims otherwise", () => {
    expect(getOwnerHandle()).toBeNull();
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "";
    expect(getOwnerHandle()).toBeNull();
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "   ";
    expect(getOwnerHandle()).toBeNull();
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "  alice  ";
    expect(getOwnerHandle()).toBe("alice");
  });
});

describe("isOwnerHandle", () => {
  it("is false for EVERY handle when the owner var is UNSET", () => {
    for (const handle of ["alice", "bob", "", "  ", null, undefined]) {
      expect(isOwnerHandle(handle)).toBe(false);
    }
  });

  it("is false for EVERY handle when the owner var is SET BUT BLANK", () => {
    // A deployment that set the var to whitespace has no owner either — a
    // separate state from unset, and a separate failure message when it breaks.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "   ";
    for (const handle of ["alice", "bob", "", "  ", null, undefined]) {
      expect(isOwnerHandle(handle)).toBe(false);
    }
  });

  it("matches the configured owner case-insensitively and nobody else", () => {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "Alice";
    expect(isOwnerHandle("alice")).toBe(true);
    expect(isOwnerHandle("ALICE")).toBe(true);
    expect(isOwnerHandle("Alice")).toBe(true);
    expect(isOwnerHandle("bob")).toBe(false);
    expect(isOwnerHandle("alice2")).toBe(false);
    expect(isOwnerHandle(null)).toBe(false);
    expect(isOwnerHandle(undefined)).toBe(false);
  });
});
