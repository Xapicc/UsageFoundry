"use client";

import Link from "next/link";
import { TaskEditor } from "@/components/TaskEditor";

/**
 * File one task.
 *
 * `runs/new` beside `runs/[id]`, and here for the same reason the edit route
 * exists: the board used to open this form as a card above itself, and the one
 * field worth a page — the brief a future agent is handed with nothing else to
 * go on — was a seven-line box on a table that was still polling underneath it.
 *
 * A static segment outranks `[id]`, so nothing about this route depends on what
 * an id can look like.
 */
export default function NewTaskPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">New task</h1>
      <p className="mb-5 max-w-[80ch] text-sm text-ink-muted">
        A brief nobody has started, and the folder it belongs to. Writing one
        down costs nothing; starting the work is a separate press. ·{" "}
        <Link href="/tasks">Back to the taskboard</Link>
      </p>
      <TaskEditor task={null} />
    </>
  );
}
