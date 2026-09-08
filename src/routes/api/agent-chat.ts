import { createFileRoute } from "@tanstack/react-router";
import { handleAgentChat } from "@/lib/server/agent-chat";

export const Route = createFileRoute("/api/agent-chat")({
  server: { handlers: { POST: ({ request }) => handleAgentChat(request) } },
});
