"use client";

import { useInterfaceLocale } from "@/components/LocaleProvider";
import type { InterfaceLocale } from "@/lib/i18n";

export function LocaleSwitcher() {
  const { locale, setLocale } = useInterfaceLocale();
  return (
    <label className="locale-switcher">
      <span className="sr-only">Interface language</span>
      <select value={locale} onChange={(event) => setLocale(event.target.value as InterfaceLocale)} aria-label="Interface language">
        <option value="en">EN</option>
        <option value="zh-CN">中文</option>
      </select>
    </label>
  );
}
