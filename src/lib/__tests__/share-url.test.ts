import { describe, it, expect } from "vitest";
import { wikiUrlFor, str } from "../share-url";

describe("wikiUrlFor", () => {
  it("public page → owner-scoped (the commons URL is retired)", () => {
    expect(wikiUrlFor("transformers", { type: "wiki" })).toBe(
      "/u/yopedia/transformers",
    );
    expect(wikiUrlFor("x", { owner: "yuanhao" })).toBe("/u/yuanhao/x");
  });

  it("html artifact → owner-scoped", () => {
    expect(wikiUrlFor("about-poke", { type: "html", owner: "yuanhao" })).toBe(
      "/u/yuanhao/about-poke",
    );
  });

  it("private page → owner-scoped", () => {
    expect(
      wikiUrlFor("secret", { visibility: "private", owner: "Alice" }),
    ).toBe("/u/alice/secret");
  });

  it("agent-scoped page → owner-scoped", () => {
    expect(
      wikiUrlFor("notes", { type: "agent-knowledge", owner: "yuanhao--yoyo" }),
    ).toBe("/u/yuanhao--yoyo/notes");
  });

  it("ownerless page falls back to the default tenant", () => {
    expect(wikiUrlFor("seed", {})).toBe("/u/yopedia/seed");
  });
});

describe("str", () => {
  it("passes strings, drops non-strings", () => {
    expect(str("hi")).toBe("hi");
    expect(str(42)).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
    expect(str(["a"])).toBeUndefined();
  });
});
