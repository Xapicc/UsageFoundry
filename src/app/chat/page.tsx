"use client";

import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";

/**
 * The orchestrator chat, which is `ChatPanel` filling the pane.
 *
 * `?chat=<id>` opens that thread rather than the latest, which is how the
 * panel on `/projects` hands over the conversation it showed. Read off
 * `window.location` once the page has mounted rather than through
 * `useSearchParams`, which would put the page behind a Suspense boundary
 * purely to read one optional parameter — `/runs/new`'s trade at its `?from=`.
 * Once is right here where `/runs` needs the hook: the page keeps the thread
 * it is on when its own address is navigated to, as it always did, and
 * without the parameter nothing here differs from the page it always was. It
 * is read, never written: opening another thread leaves the address alone.
 */
export default function ChatPage() {
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  useEffect(() => {
    setOpenChatId(new URLSearchParams(window.location.search).get("chat"));
  }, []);
  return <ChatPanel layout="page" openChatId={openChatId} />;
}
