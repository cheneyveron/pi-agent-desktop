/**
 * Automatic naming of a new session, started by its first user message.
 *
 * Runs on the server, beside the live session, so it does not depend on a
 * window staying on the session, and starts while the first turn is still
 * running instead of after it: a long first task no longer leaves the session
 * untitled for its whole length. Pi writes a new session's file only once an
 * assistant message exists; the name lives in the session meanwhile and is
 * written with it.
 */

interface EntryLike {
  type: string;
  message?: { role?: string };
}

/** True while the session holds no user message besides (at most) its first one. */
export function isFirstUserMessage(entries: readonly EntryLike[]): boolean {
  let users = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "user" && ++users > 1) return false;
  }
  return true;
}

export interface AutoNameTarget {
  sessionName(): string | undefined;
  /** Whether the session holds only its first user message. */
  isFirstUserMessage(): boolean;
  generate(): Promise<string>;
  apply(title: string): void;
  isAlive(): boolean;
  log(message: string): void;
}

const MAX_ATTEMPTS = 2;

export class SessionAutoNamer {
  private state: "waiting" | "naming" | "retry" | "done" = "waiting";
  private attempts = 0;
  private readonly target: AutoNameTarget;

  constructor(target: AutoNameTarget) {
    this.target = target;
  }

  /**
   * A user message was recorded. Only the first one of an unnamed session
   * starts naming; a resumed session, or one named before its first prompt
   * (scheduled runs, sub-agents, the user), is left alone for good.
   */
  onUserMessage(): void {
    if (this.state !== "waiting") return;
    if (this.target.sessionName() || !this.target.isFirstUserMessage()) {
      this.state = "done";
      return;
    }
    void this.run();
  }

  /** The run ended. A failed first attempt tries once more, now with the reply to read. */
  onAgentEnd(): void {
    if (this.state === "retry") void this.run();
  }

  private async run(): Promise<void> {
    this.state = "naming";
    this.attempts += 1;
    try {
      const title = await this.target.generate();
      // A name given meanwhile (rename, /name, another window) wins.
      if (this.target.isAlive() && !this.target.sessionName()) this.target.apply(title);
      this.state = "done";
    } catch (error) {
      this.state = this.attempts < MAX_ATTEMPTS ? "retry" : "done";
      this.target.log(`automatic session title failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
