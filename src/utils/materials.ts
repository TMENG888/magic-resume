/**
 * 我的资料（My Materials）—— 基于 OPFS（Origin Private File System）的
 * 浏览器端持久化文件系统。提供真实目录树与相对路径，供「我的资料」页面、
 * 资料选择器与 PI 智能体共用。
 *
 * 路径约定：相对路径，使用 "/" 分隔，例如 "个人材料/简历/爬虫简历.pdf"，
 * 不以 "/" 开头，"." 与 ".." 无特殊含义（仅作为普通名称处理时会被过滤）。
 */

export interface MaterialNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  updatedAt: number;
  children?: MaterialNode[];
}

export interface MaterialExtractResult {
  path: string;
  name: string;
  ext: string;
  kind: "file" | "dir";
  size: number;
  /** 提取出的文本内容（文本类 / PDF） */
  content?: string;
  /** 无法提取内容时的说明 */
  note?: string;
  truncated?: boolean;
}

const ROOT_DIR_NAME = "magic-materials";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log", "yml", "yaml", "xml",
  "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "java", "kt", "go", "rs", "c", "h", "cpp", "hpp", "cs", "php", "rb",
  "sh", "bat", "ps1", "sql", "ini", "toml", "conf", "env", "gitignore",
  "vue", "svelte", "dart", "swift", "scala", "r", "m",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);

const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz"]);

/** 单文件提取上限（字符） */
export const MATERIAL_FILE_CHAR_LIMIT = 16_000;
/** 单次上下文构建的总字符上限 */
export const MATERIAL_CONTEXT_CHAR_LIMIT = 80_000;
/** PDF 最多提取页数 */
export const MATERIAL_PDF_MAX_PAGES = 40;

export const isOPFSAvailable = () =>
  typeof navigator !== "undefined" && !!navigator.storage && typeof navigator.storage.getDirectory === "function";

export const isTextLikeFile = (name: string) => TEXT_EXTENSIONS.has(extensionOf(name));
export const isImageFile = (name: string) => IMAGE_EXTENSIONS.has(extensionOf(name));
export const isArchiveFile = (name: string) => ARCHIVE_EXTENSIONS.has(extensionOf(name));

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const normalizeSegments = (path: string) =>
  path.split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..");

export const joinPath = (...parts: string[]) =>
  parts.flatMap((p) => normalizeSegments(p)).join("/");

export const parentPath = (path: string) => {
  const segments = normalizeSegments(path);
  segments.pop();
  return segments.join("/");
};

export const baseName = (path: string) => {
  const segments = normalizeSegments(path);
  return segments[segments.length - 1] ?? "";
};

/* ------------------------------------------------------------------ */
/* 底层句柄                                                            */
/* ------------------------------------------------------------------ */

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

export function getMaterialsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!rootPromise) {
    rootPromise = (async () => {
      const origin = await navigator.storage.getDirectory();
      return origin.getDirectoryHandle(ROOT_DIR_NAME, { create: true });
    })();
  }
  return rootPromise;
}

async function getDirHandleByPath(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await getMaterialsRoot();
  let dir = root;
  for (const segment of normalizeSegments(path)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

async function getFileHandleByPath(path: string, create = false): Promise<FileSystemFileHandle> {
  const segments = normalizeSegments(path);
  if (segments.length === 0) throw new Error("invalid path");
  const fileName = segments.pop() as string;
  const dir = await getDirHandleByPath(segments.join("/"), create);
  return dir.getFileHandle(fileName, { create });
}

/* ------------------------------------------------------------------ */
/* 目录列举                                                            */
/* ------------------------------------------------------------------ */

type DirectoryLike = {
  values: () => AsyncIterableIterator<FileSystemHandle>;
};

async function listDirHandle(dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<MaterialNode[]> {
  const nodes: MaterialNode[] = [];
  const iterable = (dir as unknown as DirectoryLike).values();
  for await (const handle of iterable) {
    if (handle.kind === "file") {
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        nodes.push({
          name: handle.name,
          path: prefix ? `${prefix}/${handle.name}` : handle.name,
          kind: "file",
          size: file.size,
          updatedAt: file.lastModified,
        });
      } catch {
        nodes.push({
          name: handle.name,
          path: prefix ? `${prefix}/${handle.name}` : handle.name,
          kind: "file",
          size: 0,
          updatedAt: 0,
        });
      }
    } else {
      const node: MaterialNode = {
        name: handle.name,
        path: prefix ? `${prefix}/${handle.name}` : handle.name,
        kind: "dir",
        size: 0,
        updatedAt: 0,
        children: [],
      };
      if (depth > 0) {
        try {
          const subDir = await (handle as FileSystemDirectoryHandle);
          node.children = await listDirHandle(subDir, node.path, depth - 1);
          node.size = node.children.reduce((acc, child) => acc + child.size, 0);
        } catch {
          node.children = [];
        }
      }
      nodes.push(node);
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return nodes;
}

/** 列出整个资料库（递归展开完整树） */
export async function listMaterialsTree(): Promise<MaterialNode[]> {
  const root = await getMaterialsRoot();
  return listDirHandle(root, "", 12);
}

/** 列出某个子目录（不递归） */
export async function listMaterialsDir(path: string): Promise<MaterialNode[]> {
  const dir = await getDirHandleByPath(path);
  return listDirHandle(dir, normalizeSegments(path).join("/"), 0);
}

export interface MaterialStats {
  fileCount: number;
  dirCount: number;
  totalSize: number;
}

export function collectStats(nodes: MaterialNode[]): MaterialStats {
  const stats: MaterialStats = { fileCount: 0, dirCount: 0, totalSize: 0 };
  const walk = (list: MaterialNode[]) => {
    for (const node of list) {
      if (node.kind === "dir") {
        stats.dirCount += 1;
        walk(node.children ?? []);
      } else {
        stats.fileCount += 1;
        stats.totalSize += node.size;
      }
    }
  };
  walk(nodes);
  return stats;
}

export function flattenNodes(nodes: MaterialNode[], filter?: (node: MaterialNode) => boolean): MaterialNode[] {
  const out: MaterialNode[] = [];
  const walk = (list: MaterialNode[]) => {
    for (const node of list) {
      if (!filter || filter(node)) out.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/* ------------------------------------------------------------------ */
/* 写操作                                                              */
/* ------------------------------------------------------------------ */

export async function createMaterialsFolder(dirPath: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("文件夹名称不能为空");
  if (/[\\/]/.test(trimmed)) throw new Error("文件夹名称不能包含路径分隔符");
  const parent = await getDirHandleByPath(dirPath, true);
  await parent.getDirectoryHandle(trimmed, { create: true });
  return joinPath(dirPath, trimmed);
}

/** 保存一批文件到指定目录；保留 File.webkitRelativePath 中的目录结构 */
export async function saveFilesToMaterials(files: File[], dirPath: string): Promise<string[]> {
  const saved: string[] = [];
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    const segments = relative ? relative.split("/") : [file.name];
    // 去掉 webkitRelativePath 的第一段顶层根目录名，保持用户所选目录直接映射
    const innerSegments = segments.length > 1 && segments[0] === (file as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0]
      ? segments.slice(1)
      : segments;
    const finalSegments = innerSegments.length ? innerSegments : [file.name];
    const fileName = finalSegments[finalSegments.length - 1];
    const targetDir = joinPath(dirPath, ...finalSegments.slice(0, -1));

    const dir = await getDirHandleByPath(targetDir, true);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    saved.push(joinPath(targetDir, fileName));
  }
  return saved;
}

export async function renameMaterialsNode(path: string, newName: string): Promise<string> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("名称不能为空");
  if (/[\\/]/.test(trimmed)) throw new Error("名称不能包含路径分隔符");
  const segments = normalizeSegments(path);
  if (segments.length === 0) throw new Error("invalid path");
  const oldName = segments[segments.length - 1];
  if (oldName === trimmed) return path;

  const parentDir = await getDirHandleByPath(segments.slice(0, -1).join("/"));
  if (await nodeExists(parentDir, trimmed)) throw new Error("同名文件或文件夹已存在");

  const nodePath = segments.join("/");
  try {
    const fileHandle = await parentDir.getFileHandle(oldName);
    const file = await fileHandle.getFile();
    const newHandle = await parentDir.getFileHandle(trimmed, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(file);
    await writable.close();
    await parentDir.removeEntry(oldName);
    return joinPath(parentPath(path), trimmed);
  } catch {
    // 目录：递归复制后删除
    await copyDirRecursive(path, joinPath(parentPath(path), trimmed));
    await parentDir.removeEntry(oldName, { recursive: true });
    return joinPath(parentPath(path), trimmed);
  }
}

async function nodeExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch { /* not a file */ }
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch { /* not a dir */ }
  return false;
}

async function copyDirRecursive(srcPath: string, destPath: string) {
  const entries = await listMaterialsDir(srcPath);
  for (const entry of entries) {
    if (entry.kind === "dir") {
      await copyDirRecursive(entry.path, joinPath(destPath, entry.name));
    } else {
      const file = await readMaterialsFileBlob(entry.path);
      await saveFilesToMaterials([new File([file], entry.name, { type: file.type })], destPath);
    }
  }
}

export async function deleteMaterialsNode(path: string): Promise<void> {
  const segments = normalizeSegments(path);
  if (segments.length === 0) throw new Error("invalid path");
  const parentDir = await getDirHandleByPath(segments.slice(0, -1).join("/"));
  await parentDir.removeEntry(segments[segments.length - 1], { recursive: true });
}

export async function readMaterialsFileBlob(path: string): Promise<Blob> {
  const handle = await getFileHandleByPath(path);
  return handle.getFile();
}

export async function readMaterialsFileText(path: string, maxChars = MATERIAL_FILE_CHAR_LIMIT): Promise<string> {
  const blob = await readMaterialsFileBlob(path);
  const text = await blob.text();
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n…（内容过长已截断，原始长度 ${text.length} 字符）`;
  }
  return text;
}

export async function downloadMaterialsFile(path: string): Promise<void> {
  const blob = await readMaterialsFileBlob(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = baseName(path);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ */
/* 内容提取（供 AI 上下文 / 智能体读取）                                 */
/* ------------------------------------------------------------------ */

export async function extractPdfText(file: Blob, maxPages = MATERIAL_PDF_MAX_PAGES): Promise<{ text: string; truncated: boolean }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pageLimit = Math.min(pdf.numPages, maxPages);
  const chunks: string[] = [];
  let chars = 0;
  let truncated = pdf.numPages > maxPages;
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) {
      chunks.push(`【第 ${pageNumber} 页】${pageText}`);
      chars += pageText.length;
    }
    page.cleanup();
    if (chars > MATERIAL_FILE_CHAR_LIMIT) {
      truncated = true;
      break;
    }
  }
  const combined = chunks.join("\n");
  return {
    text: combined.length > MATERIAL_FILE_CHAR_LIMIT ? `${combined.slice(0, MATERIAL_FILE_CHAR_LIMIT)}…` : combined,
    truncated,
  };
}

/** 按文件类型智能提取内容 */
export async function extractMaterialContent(entry: {
  name: string;
  size: number;
  blob: Blob;
}): Promise<{ content?: string; note?: string; truncated?: boolean }> {
  const ext = extensionOf(entry.name);
  if (isTextLikeFile(entry.name)) {
    const text = await entry.blob.text();
    if (text.length > MATERIAL_FILE_CHAR_LIMIT) {
      return { content: `${text.slice(0, MATERIAL_FILE_CHAR_LIMIT)}…`, truncated: true };
    }
    return { content: text };
  }
  if (ext === "pdf") {
    try {
      const { text, truncated } = await extractPdfText(entry.blob);
      if (!text.trim()) return { note: "PDF 中未提取到文本内容（可能为扫描件/图片型 PDF）" };
      return { content: text, truncated };
    } catch {
      return { note: "PDF 解析失败" };
    }
  }
  if (isImageFile(entry.name)) {
    return { note: `图片文件（${(entry.blob.type || ext).toUpperCase()}），AI 可结合文件名理解其用途；如需图片内容请人工补充文字描述` };
  }
  if (isArchiveFile(entry.name)) {
    return { note: "压缩包文件，无法直接读取内部内容" };
  }
  if (["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(ext)) {
    return { note: `Office 文档（.${ext}），暂不支持自动提取正文，建议同时提供 PDF / 文本版本` };
  }
  return { note: "二进制文件，暂不支持内容提取" };
}

/** 提取「我的资料」中的文件 */
export async function extractMaterialsFile(path: string): Promise<MaterialExtractResult> {
  const segments = normalizeSegments(path);
  const blob = await readMaterialsFileBlob(path);
  const result = await extractMaterialContent({ name: baseName(path), size: blob.size, blob });
  return {
    path: segments.join("/"),
    name: baseName(path),
    ext: extensionOf(baseName(path)),
    kind: "file",
    size: blob.size,
    ...result,
  };
}

/** 递归提取一个资料文件夹（限制文件数与总字符） */
export async function extractMaterialsDir(
  path: string,
  options: { maxFiles?: number; charBudget?: number } = {},
): Promise<MaterialExtractResult[]> {
  const maxFiles = options.maxFiles ?? 30;
  const charBudget = options.charBudget ?? MATERIAL_CONTEXT_CHAR_LIMIT;
  const tree = await listMaterialsDir(path);
  const flat = flattenNodes(tree, (n) => n.kind === "file").slice(0, maxFiles);
  const results: MaterialExtractResult[] = [];
  let used = 0;
  for (const node of flat) {
    if (used >= charBudget) {
      results.push({ path: node.path, name: node.name, ext: extensionOf(node.name), kind: "file", size: node.size, note: "（已达上下文预算，跳过）" });
      continue;
    }
    try {
      const extracted = await extractMaterialsFile(node.path);
      const cost = extracted.content?.length ?? 0;
      if (used + cost > charBudget && extracted.content) {
        extracted.content = `${extracted.content.slice(0, Math.max(0, charBudget - used))}…（因总预算截断）`;
        extracted.truncated = true;
      }
      used += extracted.content?.length ?? 0;
      results.push(extracted);
    } catch {
      results.push({ path: node.path, name: node.name, ext: extensionOf(node.name), kind: "file", size: node.size, note: "读取失败" });
    }
  }
  return results;
}

export const MATERIAL_FILE_ICON_HINT: Record<string, string> = {
  pdf: "📄",
  doc: "📝",
  docx: "📝",
  ppt: "📊",
  pptx: "📊",
  xls: "📈",
  xlsx: "📈",
  zip: "🗜️",
  rar: "🗜️",
  "7z": "🗜️",
};
