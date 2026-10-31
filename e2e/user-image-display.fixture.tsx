import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatInput, type ChatInputHandle } from "../components/ChatInput";
import { MessageView } from "../components/MessageView";
import { I18nProvider } from "../hooks/useI18n";
import type { UserMessage, ImageContent } from "../lib/types";

const note = "[Image: original 2100x1180, displayed at 2000x1124. Multiply coordinates by 1.05 to map to original image.]";
const image: ImageContent = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==" } };
const optimistic: UserMessage = { role: "user", content: [{ type: "text", text: "describe" }, image], timestamp: 1 };
const delivered: UserMessage = { ...optimistic, content: [{ type: "text", text: `describe\n\n[Image converted from image/tiff to image/png.]\n${note}` }, image] };
function Fixture() {
  const [message, setMessage] = useState(optimistic);
  const [draft, setDraft] = useState<UserMessage | null>(null);
  const input = useRef<ChatInputHandle>(null);
  const [editing, setEditing] = useState(false);
  const [admitted, setAdmitted] = useState("");
  return <I18nProvider>
    <button onClick={() => setMessage(delivered)}>Deliver normalized event</button>
    <button onClick={() => setMessage(JSON.parse(JSON.stringify(delivered)))}>Load history</button>
    <button onClick={() => { if (draft) setMessage({ ...draft, content: [{ type: "text", text: `describe\n\n${note}` }, image] }); }}>Resend edit</button>
    <MessageView message={message} entryId="user-entry" isEditing={editing} onCancelEdit={() => setEditing(false)} onEditContent={(message) => {
      if (!input.current?.replaceMessage(message)) { setAdmitted("blocked"); return; }
      setDraft(message); setEditing(true); setAdmitted("accepted");
    }} />
    <output id="admitted">{admitted}</output>
    <ChatInput ref={input} draftKey="image-display-fixture" onClearDraft={() => setEditing(false)} onSend={() => {}} onAbort={() => {}}
      isStreaming={false} thinkingLevel="high" onThinkingLevelChange={() => {}}
      toolPreset="configured" onToolPresetChange={() => {}}
      model={{ provider: "fixture", modelId: "fixture" }} modelList={[]} />
    <output id="draft">{JSON.stringify(draft)}</output>
    <output id="stored">{JSON.stringify(delivered)}</output>
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
