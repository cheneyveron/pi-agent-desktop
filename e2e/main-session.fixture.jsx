import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../hooks/useI18n";
import { MainSessionSidebarRow, NeedsYouSection } from "../components/main-session/MainSessionSidebar";
import { MainSessionView } from "../components/main-session/MainSessionView";
import { MessageView } from "../components/MessageView";
import { MAIN_SESSION_OPEN_EVENT } from "../lib/main-session-client";

// The application's own main-session components, laid out like AppShell's
// sidebar + center column. The page talks HTTP to the e2e server, which speaks
// the service contract from the fixture backend.
const closeout = {
  sessionId: "fixture-cas", cwd: "/fixture/cas-auth", t: "2026-11-03T10:30:00", thread: "CAS-4764",
  stands: "PR #<n> 开到 dev，未合。", next: [{ text: "合并后对 dev force-sync 验证", run: "agent", on: "pr #12" }],
  produced: ["branch:cheney/bug/CAS-4764", "pr:#12"], learned: [{ text: "clp_entitlement 旧行挡刷新", anchors: [{ path: "dao/entitlement.js" }] }],
  user_said: [{ text: "push 和合 dev 先经我批准", kind: "instruction" }], open: [{ question: "客户要 ETA", who: "你", answerGoesTo: "task" }],
};
const SESSION_MESSAGES = [
  // Shapes as part B records them (lib/closeout-types.ts on PR #7).
  { role: "custom", customType: "main-session-note", display: true, content: [{ type: "text", text: "[主会话提醒] 这个 case 上次的根因在 CAS-4764，修复还没推：a58e342 在本地分支，4 天没推，没有 PR。" }], details: { v: 1, id: "note-1", t: "2026-11-03T10:21:00", text: "这个 case 上次的根因在 CAS-4764，修复还没推：a58e342 在本地分支，4 天没推，没有 PR。", task: "CAS-4764", delivery: "steer" }, timestamp: Date.parse("2026-11-03T10:21:00") },
  { role: "custom", customType: "closeout", display: true, content: closeout.stands, details: { v: 1, id: "co-cas-1", t: "2026-11-03T10:30:00", trigger: "shutdown", range: { afterEntryId: null, toEntryId: "e42", entries: 42 }, delivery: { status: "sent", at: "2026-11-03T10:30:01" }, closeout }, timestamp: Date.parse("2026-11-03T10:30:00") },
];

function Fixture() {
  const query = new URLSearchParams(location.search);
  const [view, setView] = useState(query.get("view") === "session" ? "session" : "main");
  const [task, setTask] = useState(null);
  const [opened, setOpened] = useState("");
  useEffect(() => {
    const onOpen = (event) => {
      setView("main");
      setTask(event.detail?.task ?? null);
    };
    window.addEventListener(MAIN_SESSION_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(MAIN_SESSION_OPEN_EVENT, onOpen);
  }, []);
  const openMain = (taskId) => {
    setView("main");
    setTask(taskId ?? null);
  };
  const mainOpen = view === "main";
  return <div style={{ height: "100%", display: "flex", background: "var(--canvas-background)" }}>
    <aside className="app-sidebar session-sidebar" style={{ width: "min(260px, 40vw)", flex: "0 0 auto", display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div className="session-sidebar-header" style={{ padding: "12px 10px 10px" }}>
        <MainSessionSidebarRow active={mainOpen} onOpen={() => openMain()} />
        <button type="button" className="sidebar-header-row" onClick={() => setView("session")}>会话「PCT-121470 客户又报了」</button>
      </div>
      <div className="sidebar-project-tree" role="tree" aria-label="fixture tree">
        <NeedsYouSection mainSessionOpen={mainOpen} onOpenTask={openMain} onSessionStarted={setOpened} fallbackCwd="/fixture/project" />
      </div>
    </aside>
    <main style={{ position: "relative", flex: 1, minWidth: 0, background: "var(--bg)" }}>
      {mainOpen
        ? <MainSessionView focusTask={task} fallbackCwd="/fixture/project" onSessionStarted={setOpened} onOpenSession={(id) => setOpened(`existing:${id}`)} />
        : <div style={{ height: "100%", overflow: "auto", padding: "16px 24px" }}>
          {SESSION_MESSAGES.map((message, index) => <MessageView key={index} message={message} />)}
        </div>}
      <output id="opened" style={{ position: "absolute", left: -9999 }}>{opened}</output>
    </main>
  </div>;
}

createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
