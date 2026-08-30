/**
 * Pin the Node 26 Storage shim (DW-588).
 *
 * This file's suite is the `dom` project. The 13 mounted workbench files that
 * call `window.localStorage.clear()` are the blast-radius pin; this file is
 * the contract pin — that the shim is a real Storage, that `window` and
 * `globalThis` share one instance, and that `resetDomStorage` empties both
 * stores. A regression that deleted the shim would fail those 13 files; a
 * regression that left `window.localStorage` defined but stopped resetting
 * it would not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetDomStorage } from "@/test/dom-helpers";

afterEach(() => {
  cleanup();
});

describe("the dom Storage shim (DW-588)", () => {
  it("exposes one Storage on window and globalThis for localStorage and sessionStorage", () => {
    expect(window.localStorage).toBeDefined();
    expect(window.sessionStorage).toBeDefined();
    expect(window.localStorage).toBe(globalThis.localStorage);
    expect(window.sessionStorage).toBe(globalThis.sessionStorage);
    expect(window.localStorage).not.toBe(window.sessionStorage);
  });

  it("implements getItem, setItem, removeItem, key, length, and clear", () => {
    const store = window.localStorage;
    store.clear();
    expect(store.length).toBe(0);
    expect(store.getItem("missing")).toBeNull();
    expect(store.key(0)).toBeNull();

    store.setItem("alpha", "one");
    store.setItem("beta", "two");
    expect(store.getItem("alpha")).toBe("one");
    expect(store.length).toBe(2);
    expect(store.key(0)).toBe("alpha");
    expect(store.key(1)).toBe("beta");

    store.removeItem("alpha");
    expect(store.getItem("alpha")).toBeNull();
    expect(store.length).toBe(1);

    store.clear();
    expect(store.length).toBe(0);
    expect(store.getItem("beta")).toBeNull();
  });

  it("resetDomStorage empties both stores", () => {
    window.localStorage.setItem("keep-me", "local");
    window.sessionStorage.setItem("keep-me", "session");
    resetDomStorage();
    expect(window.localStorage.getItem("keep-me")).toBeNull();
    expect(window.sessionStorage.getItem("keep-me")).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
