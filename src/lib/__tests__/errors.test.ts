import { describe, it, expect } from "vitest";
import {
  ClientInputError,
  getErrorMessage,
  isClientInputError,
  isEnoent,
  isEnotdir,
  isInfrastructureFault,
  StoreFaultError,
} from "../errors";

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
 * DW-745. The mirror of the block above, and it needs its own rows: the only
 * other thing exercising `isEnotdir` is the portable-archive probe, which
 * reaches it with a REAL fs errno every time. That path can never observe the
 * two properties this predicate's own JSDoc leans on — that a wrong code is
 * refused, and that `instanceof Error` is proven before `code` is read, so a
 * bare object wearing the code is not mistaken for the errno and a hostile
 * getter is never called at all.
 */
describe("isEnotdir", () => {
  it("returns true for an ENOTDIR error", () => {
    const err = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    expect(isEnotdir(err)).toBe(true);
  });

  it("returns false for a different error code", () => {
    // ENOENT specifically: the archive probe reads these two as OPPOSITE
    // verdicts — a missing path is a new file, an ancestor that is a file is a
    // refusal — so a predicate that confused them would silently import
    // nothing at a path it should have rejected.
    expect(isEnotdir(Object.assign(new Error("not found"), { code: "ENOENT" }))).toBe(false);
    expect(isEnotdir(Object.assign(new Error("is a directory"), { code: "EISDIR" }))).toBe(false);
  });

  it("returns false for a plain Error without code", () => {
    expect(isEnotdir(new Error("boom"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isEnotdir(null)).toBe(false);
    expect(isEnotdir(undefined)).toBe(false);
    expect(isEnotdir("ENOTDIR")).toBe(false);
    expect(isEnotdir({ code: "ENOTDIR" })).toBe(false);
  });

  it("does not read `code` off a non-Error, even one that would throw", () => {
    expect(
      isEnotdir({
        get code() {
          throw new Error("property getter exploded");
        },
      }),
    ).toBe(false);
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

describe("isInfrastructureFault", () => {
  it("returns true for a StoreFaultError", () => {
    expect(isInfrastructureFault(new StoreFaultError("Research projects file is not a list."))).toBe(true);
  });

  /**
   * DW-725. The typed branch used to be `error instanceof StoreFaultError` —
   * the identity check DW-578 had already removed from `isClientInputError`,
   * the function immediately preceding it in `errors.ts` (only the
   * `StoreFaultError` class declaration separates the two). A
   * `StoreFaultError` from a SECOND copy of the module
   * carries no errno `code` to fall back on, so it answered `false`, and
   * `POST /api/tasks/run` dropped a retryable fault onto the `/not found/i` 422
   * poison row below the infrastructure 500. Swap the implementation back to an
   * identity check and every other row here stays green; only this one fails.
   */
  it("returns true for a StoreFaultError from a DIFFERENT copy of this module", () => {
    const foreign = Object.assign(new Error("boom"), { name: "StoreFaultError" });
    expect(foreign).not.toBeInstanceOf(StoreFaultError);
    expect(isInfrastructureFault(foreign)).toBe(true);
  });

  it("returns true for a Node EINVAL errno error — the DW-481 fault", () => {
    const err = Object.assign(new Error("EINVAL: invalid argument, open '/data/x.json'"), {
      code: "EINVAL",
    });
    expect(isInfrastructureFault(err)).toBe(true);
  });

  it.each(["EACCES", "ENOSPC", "ENOENT", "EMFILE", "EIO"])(
    "returns true for errno %s",
    (code) => {
      expect(isInfrastructureFault(Object.assign(new Error("disk said no"), { code }))).toBe(true);
    },
  );

  /**
   * DW-685. These answered `true` before the rename too — the probe reads the
   * errno's shape, and these three carry it on the caught value itself — but
   * the name said "store fault" and the task door's log line sent an operator
   * to the disk for a refused socket. The verdict is unchanged and correct: a
   * network failure is infrastructure beneath us, worth the same 500 and
   * bounded retry as a broken disk. What is new is that this is NAMED
   * behavior with a row pinning it, not an accident of the regex.
   *
   * These are the codes as a socket rejection carries them. A `fetch`-shaped
   * failure does NOT reach here — undici keeps the errno on `.cause` — and an
   * underscore-bearing code (`EAI_AGAIN`) does not match the pattern. Both
   * limits are the predicate's docblock's, unchanged by the rename.
   */
  it.each(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"])(
    "returns true for network errno %s — infrastructure, not the disk",
    (code) => {
      expect(
        isInfrastructureFault(Object.assign(new Error("socket said no"), { code })),
      ).toBe(true);
    },
  );

  it("returns false for a ClientInputError — the caller's input is not our fault", () => {
    expect(isInfrastructureFault(new ClientInputError("Invalid slug: 'a b'"))).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isInfrastructureFault(new Error("EINVAL: invalid argument, open '/data/x.json'"))).toBe(false);
  });

  it("returns false for an Error whose code is not errno-shaped", () => {
    expect(isInfrastructureFault(Object.assign(new Error("nope"), { code: "invalid_request" }))).toBe(false);
    expect(isInfrastructureFault(Object.assign(new Error("nope"), { code: 42 }))).toBe(false);
  });

  it("returns false for non-Error values, errno-shaped or not", () => {
    expect(isInfrastructureFault(null)).toBe(false);
    expect(isInfrastructureFault(undefined)).toBe(false);
    expect(isInfrastructureFault("EINVAL")).toBe(false);
    expect(isInfrastructureFault({ code: "EINVAL" })).toBe(false);
    // `instanceof Error` is proven before `code` is read, so a NON-Error
    // value wearing a hostile getter cannot detonate inside a route's catch
    // block and replace the fault being reported with an unrelated second one.
    // Scoped to non-Errors on purpose: that is the guard's reach, and the
    // `isClientInputError` row below pins the identical shape.
    expect(
      isInfrastructureFault({
        get code() {
          throw new Error("property getter exploded");
        },
      }),
    ).toBe(false);
    // Same claim for `name`, the property the DW-725 typed branch reads: a bare
    // object wearing the name is NOT an Error, and `instanceof Error` is proven
    // before either property is touched, so neither getter can detonate inside
    // a route's catch block.
    expect(isInfrastructureFault({ name: "StoreFaultError" })).toBe(false);
    expect(
      isInfrastructureFault({
        get name() {
          throw new Error("property getter exploded");
        },
      }),
    ).toBe(false);
  });
});

/**
 * DW-578. Every route that answers a caller's 400 does so by classifying the
 * caught value, and `instanceof` is the one mechanism that cannot survive a
 * duplicated module graph. Swap the implementation back to an identity check
 * against the imported class and every OTHER assertion in the repo stays
 * green — each of them throws through the same module instance the route
 * imported. Only the foreign-realm case below fails, and only it stands between
 * a 400 and a production-only 500.
 */
describe("isClientInputError classifies structurally, not by identity", () => {
  it("accepts a ClientInputError from this module", () => {
    expect(isClientInputError(new ClientInputError("Invalid slug: 'a b'"))).toBe(true);
  });

  it("accepts a ClientInputError from a DIFFERENT copy of this module", () => {
    // Exactly what a duplicated module graph produces: same shape, same `name`,
    // different constructor. An identity check returns false here — the first
    // assertion is the one that fails the moment the implementation switches.
    const foreign = Object.assign(new Error("bad"), { name: "ClientInputError" });
    expect(foreign).not.toBeInstanceOf(ClientInputError);
    expect(isClientInputError(foreign)).toBe(true);
  });

  it("accepts a SUBCLASS that carries its own name", () => {
    // DW-748. A subclass exists to be TOLD APART at one door, so it must set its
    // own `name` — which is precisely what the `name` row above matches on, so
    // that row alone answers `false` here. The base class's inherited
    // `clientInput` brand is the only thing keeping the subclass a 400 at the
    // ~20 doors that classify with this predicate; delete it and the workspace
    // cap becomes a 500 at `POST /api/research`.
    class Capacity extends ClientInputError {
      constructor(message: string) {
        super(message);
        this.name = "ResearchProjectCapacityError";
      }
    }
    const err = new Capacity("This workspace already has the maximum…");
    expect(err.name).not.toBe("ClientInputError");
    expect(isClientInputError(err)).toBe(true);
  });

  it("accepts a subclass from a DIFFERENT copy of this module", () => {
    // The duplicated-graph case, one level down: a subclass instance built by a
    // foreign copy fails `instanceof` against the class the route imported and
    // carries neither our identity nor the `ClientInputError` name — only the
    // brand, which is an OWN PROPERTY and therefore survives the copy exactly as
    // `name` does one row up.
    const foreign = Object.assign(new Error("full"), {
      name: "ResearchProjectCapacityError",
      clientInput: true,
    });
    expect(foreign).not.toBeInstanceOf(ClientInputError);
    expect(isClientInputError(foreign)).toBe(true);
  });

  it("returns false for a StoreFaultError — a 500 ladder still ends in 500", () => {
    expect(isClientInputError(new StoreFaultError("boom"))).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isClientInputError(new Error("bad"))).toBe(false);
  });

  it("returns false for non-Error values, without throwing on a property read", () => {
    expect(isClientInputError(null)).toBe(false);
    expect(isClientInputError(undefined)).toBe(false);
    expect(isClientInputError("bad")).toBe(false);
    // A bare object wearing the name is NOT an Error: `instanceof Error` is
    // proven first, so the classifier never reads `name` off a hostile value.
    expect(isClientInputError({ name: "ClientInputError" })).toBe(false);
    expect(
      isClientInputError({
        get name() {
          throw new Error("property getter exploded");
        },
      }),
    ).toBe(false);
  });

  it("narrows to Error, so `.message` is readable after the check", () => {
    const err: unknown = new ClientInputError("no extractable text layer");
    if (!isClientInputError(err)) throw new Error("expected a client-input error");
    expect(err.message).toBe("no extractable text layer");
  });
});
