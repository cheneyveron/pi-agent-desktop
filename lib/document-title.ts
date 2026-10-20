/**
 * What `document.title` reads back after it is set to `title`: the HTML spec
 * strips the string and collapses every run of ASCII whitespace to one space.
 * A chat is titled by its first message, which can hold double spaces or line
 * breaks, so comparing the raw string with `document.title` never matches.
 */
export function normalizeDocumentTitle(title: string): string {
  return title.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
}

/**
 * Keeps `document.title` at `title`, putting it back whenever something else
 * rewrites the `<head>`. Returns the cleanup.
 *
 * The observer fires on every `<head>` mutation, including the one a title
 * write itself causes, so it must stop once the title already reads as wanted.
 * Comparing against the raw `title` instead made a chat whose first message had
 * a double space rewrite the title forever on the next unrelated `<head>`
 * change (opening Settings), which froze the app.
 */
export function keepDocumentTitle(doc: Document, title: string): () => void {
  const wanted = normalizeDocumentTitle(title);
  const sync = () => {
    if (doc.title !== wanted) doc.title = title;
  };

  sync();
  const observer = new MutationObserver(sync);
  observer.observe(doc.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
