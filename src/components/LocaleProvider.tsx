"use client";

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  INTERFACE_LOCALE_COOKIE,
  translateInterface,
  type InterfaceLocale,
} from "@/lib/i18n";

interface LocaleContextValue {
  locale: InterfaceLocale;
  setLocale: (locale: InterfaceLocale) => void;
  t: (source: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ initialLocale, children }: { initialLocale: InterfaceLocale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<InterfaceLocale>(initialLocale);
  const originalText = useRef(new Map<Text, string>());
  const originalAttributes = useRef(new Map<Element, Map<string, string>>());
  const setLocale = useCallback((next: InterfaceLocale) => {
    setLocaleState(next);
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${INTERFACE_LOCALE_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    document.documentElement.lang = next;
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const excluded = (element: Element | null) => Boolean(element?.closest(
      "[data-no-localize],.prose,code,pre,script,style,textarea",
    ));
    const restore = () => {
      for (const [node, value] of originalText.current) {
        if (node.isConnected) node.data = value;
      }
      for (const [element, attributes] of originalAttributes.current) {
        if (!element.isConnected) continue;
        for (const [name, value] of attributes) element.setAttribute(name, value);
      }
      originalText.current.clear();
      originalAttributes.current.clear();
    };
    if (locale === "en") {
      restore();
      return;
    }
    const applyText = (node: Text) => {
      if (excluded(node.parentElement)) return;
      const existing = originalText.current.get(node);
      const existingTranslation = existing ? translateInterface(locale, existing.trim()) : null;
      if (!existing || node.data.trim() !== existingTranslation) originalText.current.set(node, node.data);
      const source = originalText.current.get(node) ?? node.data;
      const trimmed = source.trim();
      const translated = translateInterface(locale, trimmed);
      if (trimmed && translated !== trimmed) {
        const start = source.match(/^\s*/)?.[0] ?? "";
        const end = source.match(/\s*$/)?.[0] ?? "";
        const nextValue = `${start}${translated}${end}`;
        if (node.data !== nextValue) node.data = nextValue;
      }
    };
    const applyAttributes = (element: Element) => {
      if (excluded(element)) return;
      if (element.matches("[placeholder],[aria-label],[title]")) {
        const originals = originalAttributes.current.get(element) ?? new Map<string, string>();
        for (const name of ["placeholder", "aria-label", "title"]) {
          const currentValue = element.getAttribute(name);
          if (!currentValue) continue;
          const prior = originals.get(name);
          if (!prior || currentValue !== translateInterface(locale, prior)) originals.set(name, currentValue);
          const source = originals.get(name) ?? currentValue;
          const translated = translateInterface(locale, source);
          if (currentValue !== translated) element.setAttribute(name, translated);
        }
        if (originals.size > 0) originalAttributes.current.set(element, originals);
      }
    };
    const applyNode = (root: Node) => {
      if (root instanceof Text) {
        applyText(root);
        return;
      }
      if (!(root instanceof Element) || excluded(root)) return;
      applyAttributes(root);
      for (const element of root.querySelectorAll("[placeholder],[aria-label],[title]")) applyAttributes(element);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        applyText(current as Text);
        current = walker.nextNode();
      }
    };
    const forgetNode = (root: Node) => {
      if (root.isConnected) return;
      if (root instanceof Text) {
        originalText.current.delete(root);
        return;
      }
      if (!(root instanceof Element)) return;
      originalAttributes.current.delete(root);
      for (const element of root.querySelectorAll("*")) originalAttributes.current.delete(element);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        originalText.current.delete(current as Text);
        current = walker.nextNode();
      }
    };
    const pending = new Set<Node>();
    let frame = 0;
    const schedule = (nodes: Iterable<Node>) => {
      for (const node of nodes) pending.add(node);
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const roots = [...pending];
        pending.clear();
        for (const root of roots) applyNode(root);
      });
    };
    applyNode(document.body);
    const observer = new MutationObserver((mutations) => {
      const changed: Node[] = [];
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          changed.push(...mutation.addedNodes);
          for (const node of mutation.removedNodes) forgetNode(node);
        }
        else changed.push(mutation.target);
      }
      schedule(changed);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "aria-label", "title"] });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      pending.clear();
      restore();
    };
  }, [locale]);
  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (source) => translateInterface(locale, source),
  }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useInterfaceLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useInterfaceLocale must be used inside LocaleProvider");
  return value;
}

const TRANSLATED_PROPS = new Set([
  "aria-label", "body", "helperText", "label", "linkLabel", "placeholder", "title",
]);

function translateNode(node: ReactNode, t: (source: string) => string): ReactNode {
  if (typeof node === "string") return t(node);
  if (typeof node === "number" || node === null || node === undefined || typeof node === "boolean") return node;
  if (Array.isArray(node)) return node.map((child) => translateNode(child, t));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === "code" || element.type === "pre") return element;
  const props: Record<string, unknown> = {};
  for (const name of TRANSLATED_PROPS) {
    const value = element.props[name];
    if (typeof value === "string") props[name] = t(value);
  }
  if ("children" in element.props) {
    props.children = Children.map(element.props.children as ReactNode, (child) => translateNode(child, t));
  }
  return cloneElement(element, props);
}

/** Translate only catalogued UI phrases; unknown strings and user content pass through unchanged. */
export function LocalizedSurface({ children }: { children: ReactNode }) {
  const { t } = useInterfaceLocale();
  return <>{translateNode(children, t)}</>;
}
