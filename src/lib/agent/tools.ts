import { toStringArray } from "@/app/app/dashboard/resumes/utils";
import { generateUUID } from "@/utils/uuid";
import {
  extensionOf,
  extractMaterialsDir,
  extractMaterialsFile,
  flattenNodes,
  listMaterialsTree,
} from "@/utils/materials";
import { useResumeStore } from "@/store/useResumeStore";
import type { ResumeData } from "@/types/resume";

/**
 * PI 智能体工具集（浏览器端执行）。
 *
 * 能力范围严格限定在「简历模板操作」与「我的资料读取」两类：
 *  - 简历：读取 / 更新（基本信息、教育、经历、项目、技能、自我评价、标题）、
 *          模块显隐、主题与模板切换；
 *  - 资料：列出 / 读取「我的资料」库中的文件与文件夹。
 */

export interface AgentToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, string>;
}

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: "get_resume",
    description: "读取当前简历的完整结构化内容（基本信息、教育、工作经历、项目、技能、自我评价、模块列表、主题）。",
    parameters: {},
  },
  {
    name: "update_resume",
    description:
      "更新当前简历。patch 中提供的数组字段（education/experience/projects）会整体替换对应模块；basic 为字段级合并；skills 传字符串数组；selfEvaluation 传一段纯文本；title 更新简历标题。只传需要修改的字段。",
    parameters: {
      patch: "JSON 对象，可含 title/basic/education/experience/projects/skills/selfEvaluation",
    },
  },
  {
    name: "list_resume_sections",
    description: "列出简历的模块（基本信息/专业技能/工作经验/项目经历/教育经历等）及其显示状态。",
    parameters: {},
  },
  {
    name: "toggle_resume_section",
    description: "显示或隐藏某个简历模块。",
    parameters: { sectionId: "模块 id，如 basic/skills/experience/projects/education", enabled: "true 显示 / false 隐藏" },
  },
  {
    name: "set_resume_theme",
    description: "设置简历主题色或切换模板。",
    parameters: { themeColor: "十六进制颜色，如 #1a1a1a（可选）", templateId: "模板 id（可选）" },
  },
  {
    name: "list_materials",
    description: "列出「我的资料」库中的全部文件与文件夹（相对路径）。",
    parameters: {},
  },
  {
    name: "read_material",
    description:
      "按相对路径读取「我的资料」中的文件或文件夹。支持：文本/代码/配置类、PDF（自动提取文字）、docx/pptx/xlsx/odt（自动提取正文）、zip 压缩包（列出内部清单并提取其中的文本文件）、gz。传入文件夹路径则递归读取其中所有文件（自动跳过无法提取的）。",
    parameters: { path: "「我的资料」中的相对路径，如 个人材料/简历.pdf 或 项目集/" },
  },
];

/* ------------------------------------------------------------------ */
/* 简历读写                                                            */
/* ------------------------------------------------------------------ */

const htmlToList = (items: unknown) => {
  const list = toStringArray(items);
  if (!list.length) return "";
  return `<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`;
};

/** 将简历中 HTML 正文（<ul><li>…）转回纯文本行数组（get_resume 返回全量正文用） */
const htmlToItems = (html: unknown): string[] => {
  const text = typeof html === "string" ? html.trim() : "";
  if (!text) return [];
  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const items = Array.from(doc.querySelectorAll("li"))
      .map((li) => (li.textContent ?? "").trim())
      .filter(Boolean);
    if (items.length) return items;
    const plain = (doc.body.textContent ?? "").trim();
    return plain ? plain.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return text.replace(/<[^>]+>/g, "\n").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
};

const resumeToSummary = (resume: ResumeData) => ({
  title: resume.title,
  basic: {
    name: resume.basic.name,
    title: resume.basic.title,
    email: resume.basic.email,
    phone: resume.basic.phone,
    location: resume.basic.location,
    employementStatus: resume.basic.employementStatus,
    birthDate: resume.basic.birthDate,
  },
  education: resume.education.map((item) => ({
    school: item.school, major: item.major, degree: item.degree,
    startDate: item.startDate, endDate: item.endDate, gpa: item.gpa,
    description: htmlToItems(item.description),
    visible: item.visible,
  })),
  experience: resume.experience.map((item) => ({
    company: item.company, position: item.position, date: item.date,
    details: htmlToItems(item.details),
    visible: item.visible,
  })),
  projects: resume.projects.map((item) => ({
    name: item.name, role: item.role, date: item.date,
    description: htmlToItems(item.description),
    link: item.link ?? "", linkLabel: item.linkLabel ?? "",
    visible: item.visible,
  })),
  skillContent: resume.skillContent,
  selfEvaluationContent: resume.selfEvaluationContent,
  menuSections: resume.menuSections.map((s) => ({ id: s.id, title: s.title, enabled: s.enabled, order: s.order })),
  templateId: resume.templateId,
  themeColor: resume.globalSettings?.themeColor,
});

const plainText = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function buildResumePatch(patchRaw: Record<string, unknown>): string {
  const store = useResumeStore.getState();
  const resume = store.activeResume;
  if (!resume) return "错误：没有打开的简历";
  const resumeId = resume.id;
  const applied: string[] = [];
  const now = new Date().toISOString();

  const patch = patchRaw;

  if (plainText(patch.title)) {
    applied.push(`title → ${plainText(patch.title)}`);
  }

  const basicRaw = patch.basic && typeof patch.basic === "object" && !Array.isArray(patch.basic)
    ? (patch.basic as Record<string, unknown>) : null;
  if (basicRaw) {
    const basicPatch: Partial<ResumeData["basic"]> = {};
    for (const key of ["name", "title", "email", "phone", "location", "employementStatus", "birthDate"] as const) {
      const value = plainText(basicRaw[key]);
      if (value) {
        (basicPatch as Record<string, string>)[key] = value;
        applied.push(`basic.${key} → ${value}`);
      }
    }
    if (Object.keys(basicPatch).length) {
      store.updateResume(resumeId, {
        basic: { ...resume.basic, ...basicPatch },
      });
    }
  }

  const educationRaw = Array.isArray(patch.education) ? (patch.education as Record<string, unknown>[]) : null;
  if (educationRaw) {
    const education = educationRaw.map((item) => ({
      id: generateUUID(),
      school: plainText(item.school),
      major: plainText(item.major),
      degree: plainText(item.degree),
      startDate: plainText(item.startDate),
      endDate: plainText(item.endDate),
      gpa: plainText(item.gpa),
      description: htmlToList(item.description),
      visible: true,
    }));
    store.updateResume(resumeId, { education });
    applied.push(`education 替换为 ${education.length} 条`);
  }

  const experienceRaw = Array.isArray(patch.experience) ? (patch.experience as Record<string, unknown>[]) : null;
  if (experienceRaw) {
    const experience = experienceRaw.map((item) => ({
      id: generateUUID(),
      company: plainText(item.company),
      position: plainText(item.position),
      date: plainText(item.date),
      details: htmlToList(item.details ?? item.description),
      visible: item.visible !== false,
    }));
    store.updateResume(resumeId, { experience });
    applied.push(`experience 替换为 ${experience.length} 条`);
  }

  const projectsRaw = Array.isArray(patch.projects) ? (patch.projects as Record<string, unknown>[]) : null;
  if (projectsRaw) {
    const projects = projectsRaw.map((item) => ({
      id: generateUUID(),
      name: plainText(item.name),
      role: plainText(item.role),
      date: plainText(item.date),
      description: htmlToList(item.description ?? item.details),
      link: plainText(item.link),
      linkLabel: plainText(item.linkLabel),
      visible: item.visible !== false,
    }));
    store.updateResume(resumeId, { projects });
    applied.push(`projects 替换为 ${projects.length} 条`);
  }

  if (patch.skills != null) {
    const skills = toStringArray(patch.skills);
    store.updateResume(resumeId, { skillContent: htmlToList(skills) });
    applied.push(`skills 更新为 ${skills.length} 条`);
  } else if (plainText(patch.skillContent)) {
    store.updateResume(resumeId, { skillContent: plainText(patch.skillContent) });
    applied.push("skillContent 已更新");
  }

  if (plainText(patch.selfEvaluation)) {
    store.updateResume(resumeId, { selfEvaluationContent: plainText(patch.selfEvaluation) });
    applied.push("selfEvaluation 已更新");
  }

  if (plainText(patch.title)) {
    store.updateResume(resumeId, { title: plainText(patch.title) });
  }

  if (!applied.length) return "没有可应用的修改（patch 为空或字段不合法）";
  store.updateResume(resumeId, { updatedAt: now } as Partial<ResumeData>);
  return `已应用 ${applied.length} 处修改：\n- ${applied.join("\n- ")}`;
}

export function setResumeTheme(args: Record<string, unknown>): string {
  const store = useResumeStore.getState();
  const resume = store.activeResume;
  if (!resume) return "错误：没有打开的简历";
  const applied: string[] = [];
  const themeColor = plainText(args.themeColor);
  const templateId = plainText(args.templateId);
  if (/^#[0-9a-fA-F]{3,8}$/.test(themeColor)) {
    store.setThemeColor(themeColor);
    applied.push(`主题色 → ${themeColor}`);
  }
  if (templateId) {
    store.setTemplate(templateId);
    applied.push(`模板 → ${templateId}`);
  }
  return applied.length ? `已应用：${applied.join("，")}` : "错误：未提供有效的 themeColor / templateId";
}

export function toggleResumeSection(args: Record<string, unknown>): string {
  const store = useResumeStore.getState();
  const resume = store.activeResume;
  if (!resume) return "错误：没有打开的简历";
  const sectionId = plainText(args.sectionId);
  const target = resume.menuSections.find((s) => s.id === sectionId);
  if (!target) return `错误：未找到模块 ${sectionId}，可用：${resume.menuSections.map((s) => s.id).join(", ")}`;
  const enabled = args.enabled === undefined ? !target.enabled : Boolean(args.enabled);
  if (target.enabled !== enabled) store.toggleSectionVisibility(sectionId);
  return `模块「${target.title}」已${enabled ? "显示" : "隐藏"}`;
}

/* ------------------------------------------------------------------ */
/* 我的资料                                                            */
/* ------------------------------------------------------------------ */

export async function listMaterialsForAgent(): Promise<string> {
  const tree = await listMaterialsTree();
  if (!tree.length) return "「我的资料」库为空";
  const lines: string[] = [];
  const walk = (nodes: ReturnType<typeof flattenNodes>, depth: number) => {
    for (const node of nodes) {
      lines.push(`${"  ".repeat(depth)}${node.kind === "dir" ? "[目录]" : "[文件]"} ${node.path}${node.kind === "file" ? `（${extensionOf(node.name) || "无后缀"}）` : ""}`);
      if (node.children) walk(node.children as never, depth + 1);
    }
  };
  walk(tree as never, 0);
  return lines.join("\n");
}

export async function readMaterialForAgent(args: Record<string, unknown>): Promise<string> {
  const path = plainText(args.path);
  if (!path) return "错误：缺少 path 参数";
  const node = plainText(args.kind);
  void node;
  try {
    // 目录
    const results = await extractMaterialsDir(path, { maxFiles: 20, charBudget: 30_000 });
    const output = results
      .map((result) => {
        if (result.content) {
          return `文件：${result.path}\n--- 内容 ---\n${result.content}\n--- 结束 ---`;
        }
        return `文件：${result.path}（${result.note ?? "无内容"}）`;
      })
      .join("\n\n");
    return output || `路径 ${path} 下没有可读取的文件`;
  } catch {
    // 尝试按文件读取
    try {
      const result = await extractMaterialsFile(path);
      if (result.content) return `文件：${result.path}\n--- 内容 ---\n${result.content}\n--- 结束 ---`;
      return `文件：${result.path}（${result.note ?? "无内容"}）`;
    } catch (error) {
      return `错误：无法读取 ${path}（${error instanceof Error ? error.message : "路径不存在"}）`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 分发                                                                */
/* ------------------------------------------------------------------ */

export async function executeAgentTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  try {
    switch (name) {
      case "get_resume": {
        const resume = useResumeStore.getState().activeResume;
        if (!resume) return { ok: false, summary: "错误：没有打开的简历" };
        return { ok: true, summary: "已读取当前简历", data: resumeToSummary(resume) };
      }
      case "update_resume": {
        const patch = (args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
          ? args.patch
          : args) as Record<string, unknown>;
        const summary = buildResumePatch(patch);
        return { ok: summary.startsWith("已应用"), summary };
      }
      case "list_resume_sections": {
        const resume = useResumeStore.getState().activeResume;
        if (!resume) return { ok: false, summary: "错误：没有打开的简历" };
        return {
          ok: true,
          summary: "已读取模块列表",
          data: resume.menuSections.map((s) => ({ id: s.id, title: s.title, enabled: s.enabled, order: s.order })),
        };
      }
      case "toggle_resume_section":
        return { ok: true, summary: toggleResumeSection(args) };
      case "set_resume_theme":
        return { ok: true, summary: setResumeTheme(args) };
      case "list_materials":
        return { ok: true, summary: "已读取「我的资料」列表", data: await listMaterialsForAgent() };
      case "read_material":
        return { ok: true, summary: `已读取资料 ${plainText(args.path)}`, data: await readMaterialForAgent(args) };
      default:
        return { ok: false, summary: `错误：未知工具 ${name}` };
    }
  } catch (error) {
    return { ok: false, summary: `工具执行异常：${error instanceof Error ? error.message : String(error)}` };
  }
}
