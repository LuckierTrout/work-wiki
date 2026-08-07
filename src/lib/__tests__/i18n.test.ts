import { describe, expect, it } from "vitest";
import { normalizeInterfaceLocale, translateInterface } from "../i18n";

describe("interface localization", () => {
  it("normalizes supported locales and translates catalogued UI without touching unknown content", () => {
    expect(normalizeInterfaceLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeInterfaceLocale("fr")).toBe("en");
    expect(translateInterface("zh-CN", "Knowledge Studio")).toBe("知识工作室");
    expect(translateInterface("zh-CN", "Christian's private page title")).toBe("Christian's private page title");
    expect(translateInterface("en", "Browse")).toBe("Browse");
  });
});
