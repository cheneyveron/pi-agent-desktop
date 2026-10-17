import { APP_PREF_KEYS, getPrefJson, setPrefJson } from "./app-prefs";
import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();
const MAX_PERSISTED_IMAGE_BYTES = 400_000; // approx decoded size via base64 length
const MAX_PERSISTED_DRAFTS = 40;

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function imagePersistable(image: ChatDraftImage): boolean {
  // base64 length ≈ 4/3 of bytes; keep a conservative cap so localStorage stays usable.
  return image.data.length * 0.75 <= MAX_PERSISTED_IMAGE_BYTES;
}

function hydrateFromStorage(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const stored = getPrefJson<Record<string, ChatDraft>>(APP_PREF_KEYS.chatDrafts);
  if (!stored || typeof stored !== "object") return;
  for (const [key, draft] of Object.entries(stored)) {
    if (!draft || typeof draft.value !== "string" || !Array.isArray(draft.images)) continue;
    if (isEmptyDraft(draft)) continue;
    drafts.set(key, {
      value: draft.value,
      images: draft.images
        .filter((image) => image && typeof image.data === "string" && typeof image.mimeType === "string")
        .filter(imagePersistable)
        .map((image) => ({ data: image.data, mimeType: image.mimeType })),
    });
  }
}

function schedulePersist(): void {
  if (typeof window === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const entries = [...drafts.entries()]
      .slice(-MAX_PERSISTED_DRAFTS)
      .map(([key, draft]) => [
        key,
        {
          value: draft.value,
          images: draft.images.filter(imagePersistable),
        },
      ] as const);
    setPrefJson(APP_PREF_KEYS.chatDrafts, Object.fromEntries(entries));
  }, 250);
}

export function getDraft(key: string): ChatDraft | null {
  hydrateFromStorage();
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  hydrateFromStorage();
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    schedulePersist();
    return;
  }
  // Map.set() does not refresh insertion order for an existing key. Delete it
  // first so the persistence cap below keeps the most recently edited drafts.
  drafts.delete(key);
  drafts.set(key, cloneDraft(draft));
  schedulePersist();
}

export function clearDraft(key: string): void {
  hydrateFromStorage();
  drafts.delete(key);
  schedulePersist();
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
