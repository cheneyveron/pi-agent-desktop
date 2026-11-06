"use client";

import { Fragment } from "react";
import { linkifyTasks } from "./main-session-helpers";

/** Plain text with task references (CAS-4764 …) turned into links that jump to the task. */
export function TaskText({ text, onTask }: { text: string; onTask?: (ref: string) => void }) {
  if (!text) return null;
  return (
    <>
      {text.split("\n").map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && <br />}
          {linkifyTasks(line).map((part, index) => ("task" in part && onTask ? (
            <button key={index} type="button" className="ms-task-link" onClick={() => onTask(part.task)}>{part.task}</button>
          ) : (
            <Fragment key={index}>{"task" in part ? part.task : part.text}</Fragment>
          )))}
        </Fragment>
      ))}
    </>
  );
}
