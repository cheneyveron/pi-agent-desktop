import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const searchSource = await readFile(new URL("./SessionSearch.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/sessions/search/route.ts", import.meta.url), "utf8");
const { englishMessages } = await createJiti(import.meta.url).import("../lib/i18n/locale-plugins.ts");

// The full-text session search was fully implemented upstream (component + API
// route) but the fork's rewritten sidebar never mounted it, so the feature sat
// unreachable: the search box only filtered project-tree titles. These pins keep
// the wiring attached — a merge that drops the import or the wrapper brings back
// a search box that silently searches nothing.
test("the sidebar mounts the content-search wrapper around the project tree", () => {
  assert.match(source, /import \{ SessionSearch \} from "\.\/SessionSearch"/);
  assert.match(source, /<SessionSearch\s+open=\{contentSearch\}/);
  assert.match(source, /query=\{sessionQuery\}/);
  assert.match(source, /onSelectSession=\{handleSelectSessionFromList\}/);
  // The tree must stay the wrapper's child, not a sibling the results replace.
  assert.match(source, /<SessionSearch[\s\S]{0,400}?<div ref=\{listScrollRef\} className="sidebar-project-tree" onScroll=\{handleListScroll\}>/);
});

test("the search row confirms content search with Enter, not a mode button", () => {
  assert.match(source, /const \[contentSearch, setContentSearch\] = useState\(false\)/);
  // Enter escalates the typed query to the server-side content search. The 22px
  // magnifier chip that used to sit beside the input read as a second search
  // field, so the keyboard is the only way in and clearing the row is the way
  // back out.
  assert.doesNotMatch(source, /sidebar-search-mode/);
  assert.match(source, /e\.key === "Enter"[\s\S]{0,240}?setContentSearch\(true\)/);
  assert.match(source, /e\.key === "Escape"[\s\S]{0,240}?setContentSearch\(false\)/);
  assert.match(source, /className="sidebar-search-clear"[\s\S]{0,400}?setContentSearch\(false\)/);
  // Discoverability for the hidden gesture: the input itself carries the hint.
  assert.match(source, /title=\{t\("sidebar\.searchAllHint"\)\}/);
  assert.match(englishMessages["sidebar.searchAllHint"], /Enter/);
});

test("selecting a result carries the entry id so the chat can jump to the match", () => {
  // SessionSearch hands (session, entryId, blockIndex) to the sidebar, which
  // forwards them to AppShell.handleSelectSession -> setSearchTarget.
  assert.match(searchSource, /onSelectSession\(session, entryId, blockIndex\)/);
  assert.match(source, /onSelectSession\(s, false, entryId, blockIndex\)/);
  assert.match(routeSource, /searchSessionContents\(sessions, query, request\.signal\)/);
});
