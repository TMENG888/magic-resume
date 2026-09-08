import { asRecord, fetchAI, readAIOutput, validateAIConnection } from "./ai-provider";
import { ResumeImportError } from "../resume-import-schema";
import { readLimitedJson } from "./ai-request";
import { logAgentCompletion } from "./agent-logger";

/**
 * PI 智能体对话端点（透传）。
 *
 * 智能体采用 ReAct 协议：系统提示词要求模型每轮只输出一个 JSON 对象——
 * 要么 {"action": {"tool": "...", "args": {...}}}，要么 {"reply": "..."}。
 * 工具的实际执行发生在浏览器端（简历状态 + 我的资料），由客户端驱动循环，
 * 因此该端点只需做「一次」对话补全，天然兼容全部四种协议
 * （chat-completions / responses / gemini / anthropic）。
 *
 * 输入：{ connection, system, transcript }
 * transcript 为拼接好的对话记录文本（[user]/[assistant]/[tool_result]）。
 */
export async function handleAgentChat(request: Request, fetcher: typeof fetch = fetch) {
  const startedAt = Date.now();
  let loggedConnection: Parameters<typeof logAgentCompletion>[0]["connection"];
  let loggedSystem = "";
  let loggedTranscript = "";
  try {
    const body = asRecord(await readLimitedJson(request));
    const connection = validateAIConnection(body.connection);
    const system = typeof body.system === "string" ? body.system : "";
    const transcript = typeof body.transcript === "string" ? body.transcript : "";
    if (!system || !transcript.trim()) throw new ResumeImportError("invalidRequest");

    loggedConnection = connection;
    loggedSystem = system;
    loggedTranscript = transcript;

    const response = await fetchAI(
      connection,
      { system, text: transcript, json: true, stream: false },
      request.signal,
      fetcher,
    );
    const rawJson = await response.json();
    const output = readAIOutput(connection.protocol, rawJson);
    logAgentCompletion({
      connection,
      system,
      transcript,
      rawOutput: output,
      rawJson,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ output });
  } catch (error) {
    const known = error instanceof ResumeImportError;
    const code = known ? error.code : "networkError";
    logAgentCompletion({
      connection: loggedConnection,
      system: loggedSystem,
      transcript: loggedTranscript,
      durationMs: Date.now() - startedAt,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return Response.json(
      { code, error: { code, message: `Agent request failed (${code})` } },
      { status: known ? error.status : 502 },
    );
  }
}
