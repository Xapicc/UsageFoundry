"use client";

import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";

/**
 * The orchestrator chat, which is `ChatPanel` filling the pane.
 *
 * `?chat=<id>` opens that thread rather than the latest, which is how the
 * panel on `/projects` hands over the conversation it showed. Read off
 * `window.location` once the page has mounted rather than through
 * `useSearchParams`, whose Suspense boundary would cost this page its
 * prerendered first paint — and without the parameter nothing here differs
 * from the page it always was. It is read, never written: opening another
 * thread or a new one leaves the address alone, as it always did.
 */
export default function ChatPage() {
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  useEffect(() => {
    setOpenChatId(new URLSearchParams(window.location.search).get("chat"));
  }, []);
  return <ChatPanel layout="page" openChatId={openChatId} />;
}
