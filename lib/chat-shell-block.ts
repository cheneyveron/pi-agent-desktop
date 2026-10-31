/**
 * A limited chat has no shell. When the model asks for one, the server refuses the call
 * with a reason that starts with this marker, and the conversation page uses it to offer
 * "allow this chat to use my computer" right where the need came up. Client-safe.
 */
export const CHAT_SHELL_BLOCK_MARKER = "[chat-no-shell]";

interface ToolResultLike {
  role: string;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text"
      ? String((block as { text?: unknown }).text ?? "")
      : ""))
    .join("");
}

/** Whether a shell call was refused during the latest turn (after the last user message). */
export function lastTurnHitChatShellBlock(messages: readonly ToolResultLike[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return false;
    if (message.role === "toolResult" && textOf(message.content).includes(CHAT_SHELL_BLOCK_MARKER)) return true;
  }
  return false;
}
