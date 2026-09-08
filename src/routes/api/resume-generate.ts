import { createFileRoute } from "@tanstack/react-router";
import { handleResumeGenerate } from "@/lib/server/resume-generate";

export const Route = createFileRoute("/api/resume-generate")({
  server: { handlers: { POST: ({ request }) => handleResumeGenerate(request) } },
});
