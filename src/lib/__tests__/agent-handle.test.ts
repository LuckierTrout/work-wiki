import { describe, it, expect } from "vitest";
import {
  isAgentHandle,
  DEFAULT_AGENT_NAME,
  normalizeActor,
  isAutomationActor,
  humanOwnerOf,
} from "../agent-handle";

describe("automation actors", () => {
  it("recognizes system/lint-fix/yopedia as automation (case-insensitive)", () => {
    expect(isAutomationActor("system")).toBe(true);
    expect(isAutomationActor("lint-fix")).toBe(true);
    expect(isAutomationActor("yopedia")).toBe(true);
    expect(isAutomationActor("Lint-Fix")).toBe(true);
    expect(isAutomationActor("yuanhao")).toBe(false);
    expect(isAutomationActor("yoyo")).toBe(false);
    expect(isAutomationActor("")).toBe(false);
  });

  it("normalizeActor folds automation into the agent, passes people through", () => {
    expect(normalizeActor("system")).toBe(DEFAULT_AGENT_NAME);
    expect(normalizeActor("lint-fix")).toBe(DEFAULT_AGENT_NAME);
    expect(normalizeActor("yopedia")).toBe(DEFAULT_AGENT_NAME);
    expect(normalizeActor("yuanhao")).toBe("yuanhao");
    expect(normalizeActor("yuanhao--yoyo")).toBe("yuanhao--yoyo");
  });
});

describe("isAgentHandle", () => {
  it("recognizes composite agent ids", () => {
    expect(isAgentHandle("yuanhao--yoyo")).toBe(true);
    expect(isAgentHandle("alice--scout")).toBe(true);
  });

  it("recognizes the bare default agent name (the UserLink guard hinges on this)", () => {
    expect(DEFAULT_AGENT_NAME).toBe("yoyo");
    expect(isAgentHandle("yoyo")).toBe(true);
  });

  it("treats real human handles as non-agents", () => {
    expect(isAgentHandle("yuanhao")).toBe(false);
    expect(isAgentHandle("alice")).toBe(false);
  });

  it("is false for empty/nullish", () => {
    expect(isAgentHandle(null)).toBe(false);
    expect(isAgentHandle(undefined)).toBe(false);
    expect(isAgentHandle("")).toBe(false);
  });
});

describe("humanOwnerOf", () => {
  it("strips the agent suffix from a composite agent id", () => {
    expect(humanOwnerOf("alice--yoyo")).toBe("alice");
    expect(humanOwnerOf("yuanhao--scout")).toBe("yuanhao");
  });

  it("passes a plain human handle through unchanged", () => {
    expect(humanOwnerOf("alice")).toBe("alice");
  });

  it("does NOT slugify — the raw segment is what guidance addressing wants", () => {
    // `ownerToTenant` does the storage normalization downstream; slugifying
    // here would repoint `alice_smith` to a different silo and erase a
    // non-CJK unicode handle entirely.
    expect(humanOwnerOf("alice_smith--yoyo")).toBe("alice_smith");
    expect(humanOwnerOf("Alice--yoyo")).toBe("Alice");
    expect(humanOwnerOf("алиса")).toBe("алиса");
  });

  it("passes a handle with NO human prefix through whole", () => {
    // Collapsing to "" would hand the caller an empty principal, which
    // `ownerToTenant` silently resolves to the DEFAULT silo's guidance.
    expect(humanOwnerOf("--yoyo")).toBe("--yoyo");
    expect(humanOwnerOf("--")).toBe("--");
    expect(humanOwnerOf("")).toBe("");
  });

  it("treats a BLANK human prefix as no prefix, not as a blank principal", () => {
    // `ownerToTenant` TRIMS before it decides, so a whitespace-only principal
    // collapses onto the DEFAULT tenant just as an empty one does — the exact
    // hazard `merge.ts` warns about. Returning " " here would hand the default
    // silo's Purpose and dictionary to a fold, where the raw handle addresses
    // its own tenant today.
    expect(humanOwnerOf(" --yoyo")).toBe(" --yoyo");
    expect(humanOwnerOf("\t--yoyo")).toBe("\t--yoyo");
  });

  it("returns a handle carrying no recoverable human unchanged", () => {
    // A bare legacy agent handle names an agent without saying WHOSE, and an
    // automation actor has no person behind it at all (`normalizeActor` mints
    // "yoyo" from them). Both keep addressing their own tenant, exactly as
    // they do today — this pins that deliberate non-behavior. It is also why
    // `isAgentHandle` accepts spellings this function cannot reduce.
    expect(humanOwnerOf("yoyo")).toBe("yoyo");
    expect(humanOwnerOf("system")).toBe("system");
    expect(isAgentHandle("yoyo")).toBe(true);
  });

  it("splits at the FIRST separator when the handle carries a second one", () => {
    expect(humanOwnerOf("alice--yoyo--scout")).toBe("alice");
  });
});
