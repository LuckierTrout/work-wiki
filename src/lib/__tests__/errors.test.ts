import { describe, it, expect } from "vitest";
import { ClientInputError, getErrorMessage, isEnoent, isStoreFault, StoreFaultError } from "../errors";

describe("getErrorMessage", () => {
  it("returns .message from an Error instance", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns .message from an Error subclass", () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }
    expect(getErrorMessage(new CustomError("custom boom"))).toBe("custom boom");
  });

  it("returns the string directly when error is a string", () => {
    expect(getErrorMessage("something went wrong")).toBe(
      "something went wrong",
    );
  });

  it("returns default fallback for null", () => {
    expect(getErrorMessage(null)).toBe("An unexpected error occurred");
  });

  it("returns default fallback for undefined", () => {
    expect(getErrorMessage(undefined)).toBe("An unexpected error occurred");
  });

  it("returns default fallback for a plain object", () => {
    expect(getErrorMessage({ code: 42 })).toBe("An unexpected error occurred");
  });

  it("returns default fallback for a number", () => {
    expect(getErrorMessage(404)).toBe("An unexpected error occurred");
  });

  it("uses custom fallback when provided", () => {
    expect(getErrorMessage(null, "Custom fallback")).toBe("Custom fallback");
  });

  it("handles Error with empty message", () => {
    expect(getErrorMessage(new Error(""))).toBe("");
  });
});

describe("isEnoent", () => {
  it("returns true for an ENOENT error", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(isEnoent(err)).toBe(true);
  });

  it("returns false for a different error code", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(isEnoent(err)).toBe(false);
  });

  it("returns false for a plain Error without code", () => {
    expect(isEnoent(new Error("boom"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isEnoent(null)).toBe(false);
    expect(isEnoent(undefined)).toBe(false);
    expect(isEnoent("ENOENT")).toBe(false);
    expect(isEnoent({ code: "ENOENT" })).toBe(false);
  });
});

/**
 * DW-481. A stored-artifact fault used to be indistinguishable from the
 * caller's own bad input at a route that classified by MESSAGE: the
 * filesystem's `EINVAL: invalid argument, open '…'` matched an /invalid/
 * ladder and came back as the caller's 400, which they then retried forever.
 * The type and the errno probe are what make the verdict readable.
 */
describe("StoreFaultError", () => {
  it("is an Error subclass carrying its own name and message", () => {
    const err = new StoreFaultError("Research projects file is not a list.");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StoreFaultError");
    expect(err.message).toBe("Research projects file is not a list.");
  });

  it("keeps a `cause` when one is passed", () => {
    const cause = new SyntaxError("Unexpected token }");
    const err = new StoreFaultError("Research projects file is unreadable.", { cause });
    expect(err.cause).toBe(cause);
  });

  it("is NOT a ClientInputError — an existing 500 ladder still ends in 500", () => {
    expect(new StoreFaultError("boom")).not.toBeInstanceOf(ClientInputError);
  });

  it("reports its message through getErrorMessage unchanged", () => {
    expect(getErrorMessage(new StoreFaultError("Research project entry 2 is invalid."))).toBe(
      "Research project entry 2 is invalid.",
    );
  });
});

describe("isStoreFault", () => {
  it("returns true for a StoreFaultError", () => {
    expect(isStoreFault(new StoreFaultError("Research projects file is not a list."))).toBe(true);
  });

  it("returns true for a Node EINVAL errno error — the DW-481 fault", () => {
    const err = Object.assign(new Error("EINVAL: invalid argument, open '/data/x.json'"), {
      code: "EINVAL",
    });
    expect(isStoreFault(err)).toBe(true);
  });

  it.each(["EACCES", "ENOSPC", "ENOENT", "EMFILE", "EIO"])(
    "returns true for errno %s",
    (code) => {
      expect(isStoreFault(Object.assign(new Error("disk said no"), { code }))).toBe(true);
    },
  );

  it("returns false for a ClientInputError — the caller's input is not our fault", () => {
    expect(isStoreFault(new ClientInputError("Invalid slug: 'a b'"))).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isStoreFault(new Error("EINVAL: invalid argument, open '/data/x.json'"))).toBe(false);
  });

  it("returns false for an Error whose code is not errno-shaped", () => {
    expect(isStoreFault(Object.assign(new Error("nope"), { code: "invalid_request" }))).toBe(false);
    expect(isStoreFault(Object.assign(new Error("nope"), { code: 42 }))).toBe(false);
  });

  it("returns false for non-Error values, errno-shaped or not", () => {
    expect(isStoreFault(null)).toBe(false);
    expect(isStoreFault(undefined)).toBe(false);
    expect(isStoreFault("EINVAL")).toBe(false);
    expect(isStoreFault({ code: "EINVAL" })).toBe(false);
  });
});
