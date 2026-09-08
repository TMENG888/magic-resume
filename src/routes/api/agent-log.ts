import { createFileRoute } from "@tanstack/react-router";
import { readLimitedJson } from "@/lib/server/ai-request";
import { ResumeImportError } from "@/lib/resume-import-schema";
import { appendAgentLog, truncateField } from "@/lib/server/agent-logger";
import { isAgentLogRecord } from "@/lib/agent/log-types";

/**
 * PI 智能体执行日志上报端点。
 *
 * 客户端在每回合结束（final / error / aborted）后 POST 一条完整的
 * agent_turn 记录（记忆、思考轮次、工具调用链、最终回复），
 * 服务端校验后按天追加写入 logs/agent/agent-YYYY-MM-DD.jsonl。
 *
 * 日志是旁路能力：失败不影响对话主流程（客户端 fire-and-forget）。
 */
export const Route = createFileRoute("/api/agent-log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readLimitedJson(request);
          if (!isAgentLogRecord(body)) throw new ResumeImportError("invalidRequest");

          // 超长字段兜底截断（客户端已截，双保险）
          const record = {
            ...body,
            userMessage: truncateField(body.type === "agent_turn" ? body.userMessage : ""),
          } as Record<string, unknown>;

          const result = await appendAgentLog(record as never);
          return Response.json(result, { status: result.ok ? 200 : 500 });
        } catch (error) {
          const known = error instanceof ResumeImportError;
          const code = known ? error.code : "invalidRequest";
          return Response.json(
            { ok: false, code, message: `Agent log failed (${code})` },
            { status: known ? error.status : 400 },
          );
        }
      },
    },
  },
});
