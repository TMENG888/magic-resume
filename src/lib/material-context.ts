/**
 * 资料附件（MaterialAttachment）与 AI 上下文构建。
 *
 * 附件有两个来源：
 *  - materials：「我的资料」库（OPFS），以相对路径引用，发送时按路径实时读取；
 *  - local：用户通过加号直接选择的本地文件（内存 File 对象）。
 *
 * 在实际请求大模型时，会构建为结构化上下文文本块，注入系统提示词，
 * 同时保留原始路径信息（我的资料相对路径 / 本地文件名），便于模型引用。
 */

import { generateUUID } from "@/utils/uuid";
import {
  baseName,
  extensionOf,
  extractMaterialContent,
  extractMaterialsDir,
  extractMaterialsFile,
  formatBytes,
  MATERIAL_CONTEXT_CHAR_LIMIT,
  type MaterialExtractResult,
} from "@/utils/materials";

export interface MaterialAttachment {
  id: string;
  source: "materials" | "local";
  /** materials: 库内相对路径；local: 文件名（含本地相对路径提示）或文件夹名 */
  path: string;
  name: string;
  kind: "file" | "dir";
  size?: number;
  /** 仅本地文件（kind === "file"） */
  file?: File;
  /** 仅本地文件夹（kind === "dir"）：内存中包含的全部文件（webkitRelativePath 保留目录结构） */
  files?: File[];
}

export const createMaterialsAttachment = (
  partial: Omit<MaterialAttachment, "id">,
): MaterialAttachment => ({ id: generateUUID(), ...partial });

export const attachmentLabel = (attachment: MaterialAttachment) =>
  attachment.source === "materials" ? attachment.path : attachment.name;

/** 单个附件提取 */
export async function extractAttachment(attachment: MaterialAttachment): Promise<MaterialExtractResult[]> {
  try {
    if (attachment.kind === "dir") {
      if (attachment.source === "materials") {
        return await extractMaterialsDir(attachment.path);
      }
      // 本地文件夹：遍历内存 File 列表，路径取 webkitRelativePath，
      // 与「我的资料」目录附件保持一致的应用方式（按路径逐个提取，带预算限制）
      const files = attachment.files ?? [];
      const maxFiles = 30;
      const results: MaterialExtractResult[] = [];
      let used = 0;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const relative =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        if (index >= maxFiles) {
          results.push({
            path: relative,
            name: relative,
            ext: extensionOf(file.name),
            kind: "file",
            size: file.size,
            note: "（已达文件夹内文件数上限，跳过）",
          });
          continue;
        }
        const extracted = await extractMaterialContent({ name: relative, size: file.size, blob: file });
        const cost = extracted.content?.length ?? 0;
        let content = extracted.content;
        let truncated = extracted.truncated;
        if (content && used + cost > MATERIAL_CONTEXT_CHAR_LIMIT) {
          content = `${content.slice(0, Math.max(0, MATERIAL_CONTEXT_CHAR_LIMIT - used))}…（因总预算截断）`;
          truncated = true;
        }
        used += content?.length ?? 0;
        results.push({
          path: relative,
          name: relative,
          ext: extensionOf(file.name),
          kind: "file",
          size: file.size,
          content,
          note: extracted.note,
          truncated,
        });
      }
      return results;
    }
    if (attachment.source === "materials") {
      return [await extractMaterialsFile(attachment.path)];
    }
    if (attachment.file) {
      const blob = attachment.file;
      const result = await extractMaterialContent({ name: attachment.name, size: blob.size, blob });
      return [{
        path: attachment.path,
        name: attachment.name,
        ext: attachment.name.split(".").pop()?.toLowerCase() ?? "",
        kind: "file",
        size: blob.size,
        ...result,
      }];
    }
    return [];
  } catch (error) {
    return [{
      path: attachmentLabel(attachment),
      name: attachment.name,
      ext: "",
      kind: attachment.kind,
      size: attachment.size ?? 0,
      note: `读取失败：${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}

const renderExtracted = (result: MaterialExtractResult, index: number) => {
  const lines: string[] = [];
  lines.push(`[${index}] ${result.kind === "dir" ? "文件夹" : "文件"}：${result.path}（${formatBytes(result.size)}）`);
  if (result.content) {
    lines.push("--- 内容开始 ---");
    lines.push(result.content);
    lines.push("--- 内容结束 ---");
  } else if (result.note) {
    lines.push(`说明：${result.note}`);
  }
  if (result.truncated) lines.push("（内容因长度限制被截断）");
  return lines.join("\n");
};

/** 将一组附件构建为可注入系统提示词的上下文文本块 */
export async function buildMaterialContextBlock(
  attachments: MaterialAttachment[],
  options: { totalCharLimit?: number } = {},
): Promise<string> {
  if (!attachments.length) return "";
  const totalCharLimit = options.totalCharLimit ?? MATERIAL_CONTEXT_CHAR_LIMIT;
  const sections: string[] = [];
  let used = 0;
  let index = 1;

  for (const attachment of attachments) {
    const results = await extractAttachment(attachment);
    for (const result of results) {
      let rendered = renderExtracted(result, index);
      if (used + rendered.length > totalCharLimit) {
        const remain = totalCharLimit - used;
        if (remain <= 200) {
          sections.push(`[${index}] ${result.path}（因上下文总预算限制被跳过）`);
          index += 1;
          continue;
        }
        rendered = `${rendered.slice(0, remain)}…（因上下文总预算截断）`;
      }
      used += rendered.length;
      sections.push(rendered);
      index += 1;
    }
  }

  return [
    "=== 用户附加资料（系统自动提取） ===",
    "以下内容来自用户通过「我的资料」或本地选择的附件，路径为「我的资料」相对路径或本地文件名：",
    ...sections,
    "=== 附加资料结束 ===",
  ].join("\n");
}

/** 本地文件快捷构造 */
export const localFileAttachment = (file: File): MaterialAttachment =>
  createMaterialsAttachment({
    source: "local",
    path: file.name,
    name: file.name,
    kind: "file",
    size: file.size,
    file,
  });

export const describeAttachment = (attachment: MaterialAttachment) => {
  const kindText = attachment.kind === "dir" ? "文件夹" : "文件";
  const sizeText = attachment.size != null ? formatBytes(attachment.size) : "";
  return `${kindText} ${baseName(attachment.name)}${sizeText ? ` · ${sizeText}` : ""}`;
};
