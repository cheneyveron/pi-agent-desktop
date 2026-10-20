"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  FIND_MAX_MATCHES,
  buildDomTextIndex,
  clearFindHighlights,
  findInIndex,
  paintFindHighlights,
  scrollRangeIntoView,
  type DomTextIndex,
} from "@/lib/dom-find";

interface FindBarProps {
  /** Scroll container whose rendered text is searched. */
  rootRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** Bumped on every Ctrl/Cmd+F so a second press re-focuses and selects the field. */
  focusToken: number;
  /** Text to seed the field with on the press that bumped `focusToken` (the page selection), if any. */
  seed: string | null;
  onClose: () => void;
  /** Extra class for per-surface placement. */
  className?: string;
}

export function FindBar({ rootRef, open, focusToken, seed, onClose, className }: FindBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [capped, setCapped] = useState(false);
  const [current, setCurrent] = useState(0);
  const indexRef = useRef<{ revision: number; index: DomTextIndex } | null>(null);
  // Bumped (throttled) whenever the searched subtree changes, so streaming
  // output, live file reloads and mode switches are re-indexed.
  const [revision, setRevision] = useState(0);
  const scrollPendingRef = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    if (seed) setQuery(seed);
    scrollPendingRef.current = true;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [open, focusToken, seed]);

  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      // Throttle, not debounce: streaming output mutates continuously.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setRevision((value) => value + 1);
      }, 250);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [open, rootRef]);

  useEffect(() => {
    if (!open) {
      indexRef.current = null;
      setRanges([]);
      return;
    }
    const root = rootRef.current;
    if (!root || !query) {
      setRanges([]);
      setCapped(false);
      return;
    }
    if (!indexRef.current || indexRef.current.revision !== revision) {
      indexRef.current = { revision, index: buildDomTextIndex(root) };
    }
    const result = findInIndex(indexRef.current.index, query, caseSensitive);
    setRanges(result.ranges);
    setCapped(result.capped);
  }, [open, query, caseSensitive, revision, rootRef]);

  // A new query or toggle restarts at the first match; a content refresh keeps the position.
  useEffect(() => {
    scrollPendingRef.current = true;
    setCurrent(0);
  }, [query, caseSensitive]);

  const safeCurrent = ranges.length === 0 ? 0 : Math.min(current, ranges.length - 1);

  useEffect(() => {
    if (!open) {
      clearFindHighlights();
      return;
    }
    paintFindHighlights(ranges, safeCurrent);
    const range = ranges[safeCurrent];
    const root = rootRef.current;
    if (range && root && scrollPendingRef.current) {
      scrollRangeIntoView(root, range);
    }
    scrollPendingRef.current = false;
  }, [open, ranges, safeCurrent, rootRef]);

  useEffect(() => clearFindHighlights, []);

  const step = useCallback((delta: number) => {
    if (ranges.length === 0) return;
    scrollPendingRef.current = true;
    setCurrent((value) => (Math.min(value, ranges.length - 1) + delta + ranges.length) % ranges.length);
  }, [ranges.length]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // The bar owns Escape; otherwise the global handler would also stop a running agent.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      onClose();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.nativeEvent.isComposing) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };

  if (!open) return null;

  const total = ranges.length;
  const countLabel = !query
    ? ""
    : total === 0
      ? t("find.noResults")
      : `${safeCurrent + 1}/${capped ? `${FIND_MAX_MATCHES}+` : total}`;

  return (
    <div className={`find-bar${className ? ` ${className}` : ""}`} role="search" aria-label={t("find.label")} onKeyDown={handleKeyDown}>
      <input
        ref={inputRef}
        type="text"
        className="find-bar-input"
        value={query}
        placeholder={t("find.placeholder")}
        aria-label={t("find.label")}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setQuery(event.target.value)}
      />
      <span className="find-bar-count" aria-live="polite" data-empty={query && total === 0 ? "true" : undefined}>
        {countLabel}
      </span>
      <button
        type="button"
        className="file-viewer-icon-button"
        aria-pressed={caseSensitive}
        title={t("find.matchCase")}
        aria-label={t("find.matchCase")}
        onClick={() => setCaseSensitive((value) => !value)}
      >
        <span aria-hidden="true" className="find-bar-case-glyph">Aa</span>
      </button>
      <button
        type="button"
        className="file-viewer-icon-button"
        title={t("find.previous")}
        aria-label={t("find.previous")}
        disabled={total === 0}
        onClick={() => step(-1)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
      </button>
      <button
        type="button"
        className="file-viewer-icon-button"
        title={t("find.next")}
        aria-label={t("find.next")}
        disabled={total === 0}
        onClick={() => step(1)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <button
        type="button"
        className="file-viewer-icon-button"
        title={t("find.close")}
        aria-label={t("find.close")}
        onClick={onClose}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
  );
}
