import { asRecord, fetchAI, readAIOutput, validateAIConnection } from "./ai-provider";
import { ResumeImportError, parseJsonPayload, validateResume } from "../resume-import-schema";
import { readLimitedJson } from "./ai-request";

export interface ResumeGenerateRequest {
  connection: unknown;
  jd: string;
  extraRequirements?: string;
  materialContext?: string;
  /** 当前简历上下文（智能体在 workbench 中触发生成时携带） */
  currentResumeContext?: string;
}

const SYSTEM_PROMPT = `你是一位资深的简历定制专家。用户会提供目标岗位的 JD（职位描述）以及他的个人能力资料（工作经历、项目、技能、证书等原始素材，可能来自多个文件，顺序与完整性不保证）。

你的任务：生成一份针对该岗位高度定制的求职简历 JSON。

规则：
1. 提炼 JD 中的岗位职责与任职要求关键词，将个人资料中最匹配的经历放在最前面并重写强调；与岗位无关的内容弱化或省略。
2. 只能使用用户资料中真实存在的信息进行重组与措辞优化，禁止虚构公司、职位、时间、数字。资料未覆盖的字段留空。
3. 描述（description / details）使用与资料一致的语言（通常为中文），输出为字符串数组，每条一条成果或职责，优先使用"动词 + 技术手段 + 量化结果"的写法。
4. skills 输出与岗位最相关的技能数组（12 条以内）。
5. title 为简历标题，建议包含岗位方向，如 "后端开发工程师简历"。
6. 不要输出 markdown 或解释，只返回一个 JSON 对象，结构如下：
{
  "title": "",
  "basic": { "name": "", "title": "", "email": "", "phone": "", "location": "", "employementStatus": "", "birthDate": "" },
  "education": [{ "school": "", "major": "", "degree": "", "startDate": "", "endDate": "", "gpa": "", "description": [] }],
  "experience": [{ "company": "", "position": "", "date": "", "details": [] }],
  "projects": [{ "name": "", "role": "", "date": "", "description": [], "link": "", "linkLabel": "" }],
  "skills": []
}`;

export async function handleResumeGenerate(request: Request, fetcher: typeof fetch = fetch) {
  try {
    const body = asRecord(await readLimitedJson(request));
    const connection = validateAIConnection(body.connection);
    const jd = typeof body.jd === "string" ? body.jd.trim() : "";
    if (!jd) throw new ResumeImportError("invalidRequest");
    const extra = typeof body.extraRequirements === "string" ? body.extraRequirements.trim() : "";
    const materialContext = typeof body.materialContext === "string" ? body.materialContext : "";
    const currentResumeContext = typeof body.currentResumeContext === "string" ? body.currentResumeContext : "";

    const userParts: string[] = [
      "【目标岗位 JD】",
      jd,
    ];
    if (extra) userParts.push("", "【用户的补充要求】", extra);
    if (materialContext) userParts.push("", materialContext);
    if (currentResumeContext) userParts.push("", "【当前简历内容（可在此基础上结合 JD 调整）】", currentResumeContext);
    userParts.push("", "请依据以上内容输出定制简历 JSON。");

    const abort = new AbortController();
    const signal = request.signal;
    const response = await fetchAI(
      connection,
      { system: SYSTEM_PROMPT, text: userParts.join("\n"), json: true, stream: false },
      signal,
      fetcher,
    );
    const output = readAIOutput(connection.protocol, await response.json());
    const parsed = parseJsonPayload(output);
    const validated = validateResume(parsed);
    return Response.json(validated);
  } catch (error) {
    const known = error instanceof ResumeImportError;
    const code = known ? error.code : "networkError";
    return Response.json(
      { code, error: { code, message: `Resume generation failed (${code})` } },
      { status: known ? error.status : 502 },
    );
  }
}
