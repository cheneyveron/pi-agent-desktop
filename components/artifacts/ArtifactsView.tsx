"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isImeComposing } from "@/lib/ime";
import { formatRelativeTime } from "@/lib/i18n/format";
import { ARTIFACT_TYPES } from "@/lib/artifacts";
import type { ArtifactListResponse, IndexedArtifactVersion, OutputSummary } from "@/lib/artifact-index";
import type { NativeMenuEntry } from "@/lib/desktop-menu-model";
import { getFileDirectory } from "@/lib/file-paths";
import { showMenu } from "@/hooks/useFileContextMenu";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { openPathNative, revealItemInDirNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";
import { getDesktopPlatform } from "@/lib/desktop-window";
import { revealLabelKey } from "@/lib/file-context-menu";
import { AppSelect } from "../AppSelect";
import { ARTIFACT_TYPE_LABEL } from "../ArtifactCard";
import { ARTIFACT_TOOLBAR_ICON, ArtifactView } from "../ArtifactView";
import { ArtifactThumbnail } from "./ArtifactThumbnail";
import { FileOutputView } from "./FileOutputView";
import {
  TYPE_ALL_ARTIFACTS,
  TYPE_EVERYTHING,
  TYPE_OUTPUT_FILES,
  TYPE_PROCESS_FILES,
  artifactKey,
  countProcessFiles,
  filterArtifacts,
  scopeOptions,
} from "./artifacts-helpers";

interface Props {
  /** How many sessions are running; the list reloads when one finishes. */
  runningCount: number;
  /** Opens the conversation scrolled to the entry. Resolves false when the session is gone. */
  onOpenInConversation: (sessionId: string, entryId: string) => Promise<boolean>;
  /** Forks the conversation at the entry and sends `prompt` there. Rejects with a message to show. */
  onContinueInNewChat: (sessionId: string, entryId: string, prompt: string) => Promise<void>;
}

type ItemVersion = Omit<IndexedArtifactVersion, "hash">;
type Detail =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; versions: ItemVersion[] }
  | { key: string; status: "missing" | "error"; error?: string };

const SEARCH_DEBOUNCE_MS = 250;
/** Focusing the window refreshes the list at most this often. */
const FOCUS_REFRESH_MIN_MS = 10_000;
const LIST_CACHE_MAX = 10;
/**
 * List column width. 300 still fits the thumbnail, a readable title and the tags;
 * past 640 rows gain nothing but whitespace. The preview keeps at least
 * PREVIEW_MIN_WIDTH, so on a narrow window the list stops earlier.
 */
const LIST_DEFAULT_WIDTH = 360;
const LIST_MIN_WIDTH = 300;
const LIST_MAX_WIDTH = 640;
const PREVIEW_MIN_WIDTH = 360;

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95L12 2.5z" />
    </svg>
  );
}

// The last lists by search text, kept while the app runs: reopening the page
// shows them at once and refreshes in the background instead of starting empty.
const listCache = new Map<string, { data: ArtifactListResponse; json: string }>();
let lastListLoadAt = 0;

function cacheList(search: string, data: ArtifactListResponse, json: string) {
  listCache.delete(search);
  listCache.set(search, { data, json });
  if (listCache.size > LIST_CACHE_MAX) listCache.delete(listCache.keys().next().value!);
}

/**
 * The Artifacts page: every artifact from every conversation, searchable, with
 * a preview that does not depend on the conversation being open. Scripted
 * content shows its source until the user picks Preview, like other history.
 */
export function ArtifactsView({ runningCount, onOpenInConversation, onContinueInNewChat }: Props) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [scope, setScope] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [rowMenuError, setRowMenuError] = useState<string | null>(null);
  const [list, setList] = useState<ArtifactListResponse | null>(() => listCache.get("")?.data ?? null);
  /** The search the shown list answers; it lags `search` while a new one loads. */
  const [listSearch, setListSearch] = useState<string | null>(() => (listCache.has("") ? "" : null));
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<OutputSummary | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The version a "continue in new chat" request is being written for. */
  const [continueIndex, setContinueIndex] = useState<number | null>(null);
  const [continueText, setContinueText] = useState("");
  const [continueBusy, setContinueBusy] = useState(false);
  const listWidthRef = useRef(LIST_DEFAULT_WIDTH);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The page fills the main column, not the window: the sidebar sits beside it.
  const getListMaxWidth = useCallback(
    () => (rootRef.current?.clientWidth || window.innerWidth) - PREVIEW_MIN_WIDTH,
    [],
  );
  const listResizer = useResizablePanel({
    ariaLabel: t("artifacts.page.resizeList"),
    cssVariable: "--artifacts-list-width",
    defaultWidth: LIST_DEFAULT_WIDTH,
    getMaxWidth: getListMaxWidth,
    growthDirection: "right",
    maxWidth: LIST_MAX_WIDTH,
    minWidth: LIST_MIN_WIDTH,
    storageKey: "pi-artifacts-list-width",
    widthRef: listWidthRef,
  });
  const listPanelRef = listResizer.panelRef;
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    listPanelRef.current = node;
  }, [listPanelRef]);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(runningCount);
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { searchRef.current?.focus({ preventScroll: true }); }, []);

  // Overlay-style scrollbar, as in the sidebar: `is-scrolling` shows the thumb only while the list moves.
  function handleListScroll() {
    listPaneRef.current?.classList.add("is-scrolling");
    if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
    scrollHideTimerRef.current = setTimeout(() => {
      listPaneRef.current?.classList.remove("is-scrolling");
      scrollHideTimerRef.current = null;
    }, 800);
  }
  useEffect(() => () => {
    if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // A finished run may have written artifacts; so may another window.
  useEffect(() => {
    if (runningCount < runningRef.current) setReload((n) => n + 1);
    runningRef.current = runningCount;
  }, [runningCount]);
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastListLoadAt >= FOCUS_REFRESH_MIN_MS) setReload((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const cached = listCache.get(search);
    if (cached) {
      setList(cached.data);
      setListSearch(search);
    }
    fetch(`/api/artifacts?q=${encodeURIComponent(search)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const json = await response.text();
        const data = JSON.parse(json) as ArtifactListResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        lastListLoadAt = Date.now();
        // An unchanged answer keeps the list's identity, so no row re-renders.
        const previous = listCache.get(search);
        const next = previous?.json === json ? previous.data : data;
        cacheList(search, next, json);
        setList(next);
        setListSearch(search);
        setListError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setListError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, reload]);

  const items = useMemo(() => list?.artifacts ?? [], [list]);
  const scopes = useMemo(() => scopeOptions(items, t("artifacts.page.chats")), [items, t]);
  // A scope that left the list (search narrowed it away) stops filtering.
  const effectiveScope = scopes.some((option) => option.value === scope) ? scope : "";
  const visible = useMemo(() => filterArtifacts(items, type, effectiveScope, favoritesOnly), [items, type, effectiveScope, favoritesOnly]);
  const hiddenProcess = useMemo(
    () => (type || favoritesOnly ? 0 : countProcessFiles(items, effectiveScope)),
    [items, type, effectiveScope, favoritesOnly],
  );

  // Follow the selected artifact's newest summary, so a reload that brought a
  // new version also refreshes the preview.
  const selectedKey = selected ? artifactKey(selected) : null;
  const current = selectedKey ? items.find((item) => artifactKey(item) === selectedKey) ?? selected : null;
  // Files load their own detail (FileOutputView); this effect is for artifacts.
  const currentArtifact = current?.kind === "artifact" ? current : null;
  const revision = currentArtifact ? `${currentArtifact.versionCount}:${currentArtifact.updated}` : "";

  useEffect(() => {
    if (!currentArtifact || !selectedKey) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail((previous) => (previous?.key === selectedKey && previous.status === "ready" ? previous : { key: selectedKey, status: "loading" }));
    const params = new URLSearchParams({ session: currentArtifact.sessionId, identifier: currentArtifact.identifier });
    fetch(`/api/artifacts/item?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { versions?: ItemVersion[]; error?: string };
        if (response.status === 404) {
          setDetail({ key: selectedKey, status: "missing" });
          return;
        }
        if (!response.ok || !data.versions) throw new Error(data.error ?? `HTTP ${response.status}`);
        setDetail({ key: selectedKey, status: "ready", versions: data.versions });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetail({ key: selectedKey, status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
    // `currentArtifact` is read for its ids, which `selectedKey` covers; `revision` refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, revision]);

  const versions = detail?.key === selectedKey && detail.status === "ready" ? detail.versions : undefined;

  function selectItem(item: OutputSummary | null) {
    setActionError(null);
    setFavoriteError(null);
    setContinueIndex(null);
    setContinueText("");
    setSelected(item);
  }

  const continueVersion = continueIndex !== null ? versions?.[continueIndex] : undefined;

  /**
   * Right-click on a row, in the desktop app: open the conversation that
   * produced it; for a file also open it with the system's default app and
   * show it in its folder. In a browser the browser's own menu stays.
   */
  function showRowMenu(event: MouseEvent, item: OutputSummary) {
    if (!isTauriDesktop()) return;
    event.preventDefault();
    setRowMenuError(null);
    const fail = (error: unknown) => setRowMenuError(t("artifacts.page.menuFailed", { error: error instanceof Error ? error.message : String(error) }));
    const conversation = item.conversation;
    const entries: NativeMenuEntry[] = [{
      label: t("artifacts.page.menuOpenConversation"),
      disabled: !conversation,
      onSelect: () => {
        if (!conversation) return;
        onOpenInConversation(conversation.sessionId, conversation.entryId)
          .then((opened) => { if (!opened) setRowMenuError(t("artifacts.page.sessionMissing")); })
          .catch(fail);
      },
    }];
    if (item.kind === "file") {
      entries.push(
        { kind: "separator" },
        { label: t("artifacts.page.menuOpenDefault"), onSelect: () => { openPathNative(item.path).catch(fail); } },
        { label: t(revealLabelKey(getDesktopPlatform())), onSelect: () => { revealItemInDirNative(item.path).catch(fail); } },
      );
    }
    void showMenu(entries, { x: event.clientX, y: event.clientY });
  }

  async function toggleFavorite(item: OutputSummary) {
    const favorite = !item.favorite;
    const key = artifactKey(item);
    setFavoriteError(null);
    setFavoriteBusy(true);
    try {
      const target = item.kind === "file"
        ? { kind: "file", path: item.path }
        : { kind: "artifact", sessionId: item.sessionId, identifier: item.identifier };
      const response = await fetch("/api/artifacts/favorite", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, favorite }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      // Every remembered list shows the star at once; the next load confirms it.
      const mark = (data: ArtifactListResponse): ArtifactListResponse => ({
        ...data,
        artifacts: data.artifacts.map((entry) => (artifactKey(entry) === key ? { ...entry, favorite } : entry)),
      });
      for (const [search, cached] of listCache) listCache.set(search, { ...cached, data: mark(cached.data) });
      setList((current) => (current ? mark(current) : current));
      setSelected((current) => (current && artifactKey(current) === key ? { ...current, favorite } : current));
    } catch (error) {
      setFavoriteError(t("artifacts.page.favoriteFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setFavoriteBusy(false);
    }
  }

  async function submitContinue(event?: FormEvent) {
    event?.preventDefault();
    const request = continueText.trim();
    if (!currentArtifact || !continueVersion || continueIndex === null || !request || continueBusy) return;
    setContinueBusy(true);
    setActionError(null);
    try {
      await onContinueInNewChat(currentArtifact.sessionId, continueVersion.entryId, t("artifacts.page.continuePrompt", {
        title: continueVersion.title,
        identifier: currentArtifact.identifier,
        version: continueIndex + 1,
        request,
      }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setContinueBusy(false);
    }
  }

  async function openInConversation(version: ItemVersion) {
    if (!currentArtifact) return;
    setActionError(null);
    if (!(await onOpenInConversation(currentArtifact.sessionId, version.entryId))) setActionError(t("artifacts.page.sessionMissing"));
  }

  const typeOptions = [
    { value: "", label: t("artifacts.page.allTypes") },
    { value: TYPE_ALL_ARTIFACTS, label: t("artifacts.page.allArtifacts") },
    ...ARTIFACT_TYPES.map((value) => ({ value, label: ARTIFACT_TYPE_LABEL[value] })),
    { value: TYPE_OUTPUT_FILES, label: t("artifacts.page.outputFiles") },
    { value: TYPE_PROCESS_FILES, label: t("artifacts.page.processFiles") },
    { value: TYPE_EVERYTHING, label: t("artifacts.page.everything") },
  ];
  const scopeSelectOptions = [{ value: "", label: t("artifacts.page.allProjects") }, ...scopes];

  const detailMessage = !detail || detail.key !== selectedKey || detail.status === "loading"
    ? t("artifacts.page.loadingItem")
    : detail.status === "missing"
      ? t("artifacts.page.itemUnavailable")
      : detail.status === "error"
        ? t("artifacts.page.loadFailed", { error: detail.error ?? "" })
        : "";

  return (
    <div
      ref={setRootRef}
      role="region"
      style={{ "--artifacts-list-width": `${listResizer.width}px` } as CSSProperties}
      className={`artifacts-view${current ? " has-selection" : ""}`}
      tabIndex={-1}
      aria-label={t("artifacts.page.title")}
      // Esc here must not reach the global shortcut that stops the agent running behind this page.
      onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}
    >
      <div ref={listPaneRef} className="artifacts-list-pane" onScroll={handleListScroll}>
        <div className="artifacts-filters">
          <input
            ref={searchRef}
            type="search"
            className="scheduled-input artifacts-search"
            value={query}
            maxLength={200}
            placeholder={t("artifacts.page.searchPlaceholder")}
            aria-label={t("artifacts.page.searchLabel")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="artifacts-filter-row">
            <AppSelect value={type} onValueChange={setType} options={typeOptions} aria-label={t("artifacts.page.typeLabel")} className="artifacts-filter" />
            <AppSelect value={effectiveScope} onValueChange={setScope} options={scopeSelectOptions} aria-label={t("artifacts.page.scopeLabel")} className="artifacts-filter" />
            <button
              type="button"
              className="artifacts-favorite-filter"
              aria-pressed={favoritesOnly}
              title={t("artifacts.page.favoritesOnly")}
              aria-label={t("artifacts.page.favoritesOnly")}
              onClick={() => setFavoritesOnly((on) => !on)}
            >
              <StarIcon filled={favoritesOnly} />
            </button>
          </div>
        </div>
        {listError && <p className="scheduled-error" role="alert">{t("artifacts.page.loadFailed", { error: listError })}</p>}
        {!list && loading && <p className="scheduled-hint artifacts-status">{t("artifacts.page.loading")}</p>}
        {list && (
          <p className="scheduled-hint artifacts-status" role="status">
            {list.truncated ? t("artifacts.page.truncated", { count: items.length }) : t("artifacts.page.count", { count: visible.length })}
          </p>
        )}
        {list && !listError && items.length === 0 && !search && (
          <div className="scheduled-empty">
            <h3>{t("artifacts.page.emptyTitle")}</h3>
            <p>{t("artifacts.page.emptyBody")}</p>
          </div>
        )}
        {rowMenuError && <p className="scheduled-error artifacts-status" role="alert">{rowMenuError}</p>}
        {list && (items.length > 0 || search) && visible.length === 0 && (
          <p className="scheduled-hint artifacts-status">{t(favoritesOnly ? "artifacts.page.noFavorites" : "artifacts.page.noMatches")}</p>
        )}
        <ul className={`artifacts-list${loading && list && listSearch !== search ? " is-loading" : ""}`}>
          {visible.map((item) => {
            const key = artifactKey(item);
            const meta = [
              item.kind === "file" ? (item.created ? t("artifacts.page.fileCreated") : t("artifacts.page.fileEdited")) : ARTIFACT_TYPE_LABEL[item.type],
              // The count reads as part of the meta line; as a second tag it stacked under "Deleted".
              ...(item.versionCount > 1 ? [t(item.kind === "file" ? "artifacts.page.changeCount" : "artifacts.page.versionCount", { count: item.versionCount })] : []),
              ...(item.kind === "file" ? [getFileDirectory(item.displayPath) || "."] : []),
              item.sessionTitle,
              formatRelativeTime(item.updated, locale),
            ].join(" · ");
            const snippet = item.kind === "artifact" ? item.snippet : undefined;
            return (
              <li key={key}>
                <button
                  type="button"
                  className="artifacts-item"
                  aria-current={key === selectedKey ? "true" : undefined}
                  onClick={() => selectItem(item)}
                  onContextMenu={(event) => showRowMenu(event, item)}
                >
                  <ArtifactThumbnail item={item} scrollRoot={listPaneRef} />
                  <span className="artifacts-item-main">
                    <span className="artifacts-item-title">
                      {item.favorite && (
                        <span className="artifacts-item-star" title={t("artifacts.page.favorited")} aria-label={t("artifacts.page.favorited")}>
                          <StarIcon filled />
                        </span>
                      )}
                      {item.title}
                    </span>
                    <span className="artifacts-item-meta" title={meta}>{meta}</span>
                    {snippet && (
                      <span className="artifacts-item-snippet">
                        {snippet.before}<mark>{snippet.match}</mark>{snippet.after}
                      </span>
                    )}
                  </span>
                  <span className="artifacts-item-tags">
                    {item.kind === "file" && item.role === "output" && item.reasons[0] && (
                      <span className="scheduled-tag">{t(`artifacts.page.reason.${item.reasons[0]}`)}</span>
                    )}
                    {item.scheduled && <span className="scheduled-tag">{t("artifacts.page.scheduled")}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {list && hiddenProcess > 0 && (
          <p className="scheduled-hint artifacts-status artifacts-process-note">
            {t("artifacts.page.processHidden", { count: hiddenProcess })}
            <button type="button" className="artifacts-link-button" onClick={() => setType(TYPE_PROCESS_FILES)}>
              {t("artifacts.page.showProcess")}
            </button>
          </p>
        )}
      </div>

      <div
        {...listResizer.separatorProps}
        className={`panel-resize-handle artifacts-resize-handle${listResizer.isResizing ? " is-resizing" : ""}`}
        title={`${t("artifacts.page.resizeList")}: ${t("layout.resizeHint")}`}
      />
      <div className="artifacts-detail-pane">
        {current ? (
          <>
            <div className="artifacts-detail-source">
              <button type="button" className="scheduled-back artifacts-back" onClick={() => selectItem(null)}>
                ← {t("artifacts.page.back")}
              </button>
              <span className="artifacts-detail-session" title={current.sessionTitle}>
                {current.sessionTitle} · {formatRelativeTime(current.updated, locale)}
              </span>
              <button
                type="button"
                className="file-viewer-icon-button artifacts-favorite-toggle"
                aria-pressed={current.favorite}
                disabled={favoriteBusy}
                title={current.favorite ? t("artifacts.page.unfavorite") : t("artifacts.page.favorite")}
                aria-label={current.favorite ? t("artifacts.page.unfavorite") : t("artifacts.page.favorite")}
                onClick={() => void toggleFavorite(current)}
              >
                <StarIcon filled={current.favorite} />
              </button>
            </div>
            {favoriteError && <p className="scheduled-error artifacts-detail-error" role="alert">{favoriteError}</p>}
            {current.kind === "file" && (
              <FileOutputView
                key={selectedKey}
                item={current}
                onOpenInConversation={onOpenInConversation}
                onRoleChange={() => setReload((n) => n + 1)}
              />
            )}
            {currentArtifact && continueVersion && (
              <form className="artifacts-continue" onSubmit={(event) => void submitContinue(event)}>
                <label className="scheduled-hint" htmlFor="artifacts-continue-input">
                  {t("artifacts.page.continueLabel", { title: continueVersion.title, version: (continueIndex ?? 0) + 1 })}
                </label>
                <textarea
                  id="artifacts-continue-input"
                  className="scheduled-input scheduled-textarea"
                  rows={2}
                  autoFocus
                  value={continueText}
                  disabled={continueBusy}
                  placeholder={t("artifacts.page.continuePlaceholder")}
                  onChange={(event) => setContinueText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event.nativeEvent)) {
                      event.preventDefault();
                      void submitContinue();
                    } else if (event.key === "Escape") {
                      setContinueIndex(null);
                    }
                  }}
                />
                <div className="scheduled-actions">
                  <button type="button" className="scheduled-button scheduled-button--small" disabled={continueBusy} onClick={() => setContinueIndex(null)}>
                    {t("artifacts.page.cancel")}
                  </button>
                  <button type="submit" className="scheduled-button scheduled-button--small scheduled-button--primary" disabled={continueBusy || !continueText.trim()}>
                    {continueBusy ? t("artifacts.page.continueSending") : t("artifacts.page.continueSend")}
                  </button>
                </div>
              </form>
            )}
            {currentArtifact && actionError && <p className="scheduled-error artifacts-detail-error" role="alert">{actionError}</p>}
            {currentArtifact && <div className="artifacts-detail-body">
              <ArtifactView
                key={selectedKey}
                identifier={currentArtifact.identifier}
                title={currentArtifact.title}
                versions={versions}
                holdActiveContent
                emptyMessage={detailMessage}
                versionNote={(index) => (versions?.[index] && !versions[index].onActiveBranch ? t("artifacts.page.otherBranch") : null)}
                renderControls={(index) => {
                  const version = versions?.[index];
                  if (!version) return null;
                  const label = version.onActiveBranch ? t("artifacts.page.openInConversation") : t("artifacts.page.otherBranchHint");
                  return (
                    <>
                      <button
                        type="button"
                        className="file-viewer-icon-button"
                        onClick={() => {
                          setActionError(null);
                          setContinueIndex((open) => (open === index ? null : index));
                        }}
                        aria-pressed={continueIndex === index}
                        title={t("artifacts.page.continueInNewChat")}
                        aria-label={t("artifacts.page.continueInNewChat")}
                      >
                        <svg {...ARTIFACT_TOOLBAR_ICON}>
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="file-viewer-icon-button"
                        onClick={() => void openInConversation(version)}
                        disabled={!version.onActiveBranch}
                        title={label}
                        aria-label={label}
                      >
                        <svg {...ARTIFACT_TOOLBAR_ICON}>
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                      </button>
                    </>
                  );
                }}
              />
            </div>}
          </>
        ) : (
          <div className="artifacts-detail-empty">
            <p>{t("artifacts.page.selectHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
