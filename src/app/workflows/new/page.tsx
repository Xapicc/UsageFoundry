"use client";

import Link from "next/link";
import { WorkflowEditor } from "@/components/WorkflowEditor";

export default function NewWorkflowPage() {
  return (
    <>
      <div className="mb-6">
        {/* `inline-flex` only below the breakpoint, for `agents/page.tsx`'s
            reason: this is the page's back button under a thumb and owes the
            44px target, and above it it is pointed at and reads as the inline
            text it is. */}
        <Link
          href="/workflows"
          className="text-sm text-ink-muted max-md:inline-flex max-md:min-h-11 max-md:items-center"
        >
          ← Workflows
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          New workflow
        </h1>
      </div>
      <WorkflowEditor workflow={null} />
    </>
  );
}
