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

/** 列出某个子目录；depth=0 只列第一层，depth>0 递归到指定深度（-1 表示无限，慎用于大目录） */
export async function listMaterialsDir(path: string, depth = 0): Promise<MaterialNode[]> {
  const dir = await getDirHandleByPath(path);
  return listDirHandle(dir, normalizeSegments(path).join("/"), depth);
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
/**
 * 由 webkitRelativePath（或回退文件名）解析保存目标：
 * 返回目标子目录路径段与文件名。完整保留目录结构（含顶层文件夹名），
 * 上传文件夹后在资料库中以同名文件夹呈现，而不是拆散成子文件。
 */
export function resolveSaveTarget(
  relative: string,
  fallbackName: string
): { dirSegments: string[]; fileName: string } {
  const segments = relative ? relative.split("/") : [fallbackName];
  const fileName = segments[segments.length - 1] || fallbackName;
  return { dirSegments: segments.slice(0, -1), fileName };
}

const describeWriteError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : "";
  if (name === "NoModificationAllowedError") return "文件被占用，请稍后重试";
  if (name === "QuotaExceededError") return "浏览器存储空间不足";
  if (name === "TypeMismatchError") return "存在同名但类型不同的文件/文件夹";
  if (name === "NotFoundError") return "上级目录不存在";
  return error instanceof Error ? error.message : String(error);
};

export interface SaveFilesResult {
  saved: string[];
  failed: { file: string; reason: string }[];
}

/* ------------------------------------------------------------------ */
/* 上传体检与批量写入保护                                              */
/* ------------------------------------------------------------------ */

/** 单次上传文件数上限（超过则整批拒绝）*/
export const UPLOAD_MAX_FILES = 1000;
/** 单文件大小上限（超大文件跳过：OPFS 写大文件易触发浏览器内存/配额问题，且 AI 无需）*/
export const UPLOAD_MAX_FILE_SIZE = 100 * 1024 * 1024;
/** 单次上传总大小上限 */
export const UPLOAD_MAX_TOTAL_SIZE = 500 * 1024 * 1024;

export interface UploadScreenResult {
  /** 允许上传的文件（已按单文件/总量上限过滤）*/
  accepted: File[];
  /** 被跳过的超大文件 */
  skippedLarge: { name: string; size: number }[];
  /** 整批被拒的原因（非空时 accepted 为空）*/
  blocked?: string;
  totalCount: number;
  totalBytes: number;
}

/** 上传前体检：拦截超大批量/超大文件，防止浏览器内存打爆（历史教训：上万文件直接崩浏览器）。
 *  三个入口共用：智能体选择器本地落盘、「我的资料」页上传。 */
export function screenUploadFiles(files: File[]): UploadScreenResult {
  const totalCount = files.length;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalCount > UPLOAD_MAX_FILES) {
    return {
      accepted: [],
      skippedLarge: [],
      blocked: `所选文件夹包含 ${totalCount} 个文件，超过单次上传上限 ${UPLOAD_MAX_FILES} 个。建议：把文件夹压缩为 zip 后上传（AI 可读取 zip 清单与内部文本文件），或只上传核心资料。`,
      totalCount,
      totalBytes,
    };
  }
  const accepted: File[] = [];
  const skippedLarge: { name: string; size: number }[] = [];
  let used = 0;
  for (const file of files) {
    if (file.size > UPLOAD_MAX_FILE_SIZE) {
      skippedLarge.push({ name: file.name, size: file.size });
      continue;
    }
    if (used + file.size > UPLOAD_MAX_TOTAL_SIZE) {
      skippedLarge.push({ name: file.name, size: file.size });
      continue;
    }
    used += file.size;
    accepted.push(file);
  }
  return { accepted, skippedLarge, totalCount, totalBytes };
}

/** 保存一批文件到指定目录；保留 File.webkitRelativePath 的完整目录结构（含所选文件夹名）。
 *
 * 单个文件失败不中断整批（结果中返回 failed 明细）；
 * 文件锁冲突自动重试一次；父目录句柄按路径缓存，大批量上传不再逐文件重建句柄。
 * onProgress：可选进度回调（每 20 个文件通知一次，避免大批量时 UI 无反馈）。
 */
export async function saveFilesToMaterials(
  files: File[],
  dirPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SaveFilesResult> {
  const saved: string[] = [];
  const failed: SaveFilesResult["failed"] = [];
  const dirHandleCache = new Map<string, FileSystemDirectoryHandle>();

  const getDirCached = async (path: string): Promise<FileSystemDirectoryHandle> => {
    const cached = dirHandleCache.get(path);
    if (cached) return cached;
    const dir = await getDirHandleByPath(path, true);
    dirHandleCache.set(path, dir);
    return dir;
  };

  const writeFile = async (dir: FileSystemDirectoryHandle, fileName: string, file: File) => {
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  };

  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    const { dirSegments, fileName } = resolveSaveTarget(relative, file.name);
    const targetDir = joinPath(dirPath, ...dirSegments);
    const fullPath = joinPath(targetDir, fileName);
    try {
      const dir = await getDirCached(targetDir);
      try {
        await writeFile(dir, fileName, file);
      } catch (error) {
        // 文件被占用（同名文件尚有未关闭的写入流）：延迟后重试一次
        if (error instanceof Error && error.name === "NoModificationAllowedError") {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await writeFile(dir, fileName, file);
        } else {
          throw error;
        }
      }
      saved.push(fullPath);
    } catch (error) {
      failed.push({ file: fullPath, reason: describeWriteError(error) });
    }
    if (onProgress && (saved.length + failed.length) % 20 === 0) {
      onProgress(saved.length + failed.length, files.length);
    }
    // 每 100 个文件让出一次主线程，避免大批量时 IO 队列/微任务堆积拖死页面
    if ((saved.length + failed.length) % 100 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(files.length, files.length);
  return { saved, failed };
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

/* ------------------------------------------------------------------ */
/* 压缩包与 Office 文档解析（零依赖：手写 ZIP 目录解析 + 原生解压流）     */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

/** 原生 deflate-raw 解压（Chrome 103+） */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error("当前浏览器不支持 DecompressionStream");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** gzip 解压 */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error("当前浏览器不支持 DecompressionStream");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 解析 ZIP central directory，返回全部条目（零依赖，支持 stored/deflate） */
async function parseZipEntries(blob: Blob): Promise<ZipEntry[]> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 从尾部向前搜索 EOCD 签名（PK\x05\x06）
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= scanFrom; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP 目录未找到（可能为分卷或加密包）");
  const entryCount = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  const decoderFor = (flag: number) => {
    if (flag & 0x800) return new TextDecoder("utf-8");
    try {
      return new TextDecoder("gbk"); // 中文 Windows 压缩包常见非 UTF-8 文件名
    } catch {
      return new TextDecoder("utf-8");
    }
  };

  for (let i = 0; i < entryCount; i += 1) {
    if (dv.getUint32(offset, true) !== 0x02014b50) break; // PK\x01\x02
    const flag = dv.getUint16(offset + 8, true);
    const method = dv.getUint16(offset + 10, true);
    const compressedSize = dv.getUint32(offset + 20, true);
    const uncompressedSize = dv.getUint32(offset + 24, true);
    const nameLen = dv.getUint16(offset + 28, true);
    const extraLen = dv.getUint16(offset + 30, true);
    const commentLen = dv.getUint16(offset + 32, true);
    const localOffset = dv.getUint32(offset + 42, true);
    const name = decoderFor(flag).decode(buf.subarray(offset + 46, offset + 46 + nameLen));

    // local file header（PK\x03\x04）：数据区 = local + 30 + fnLen + extraLen
    const localFnLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localFnLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name,
      size: uncompressedSize,
      read: async () => (method === 0 ? new Uint8Array(raw) : await inflateRaw(raw)),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 从 XML 文本中按标签提取文本（命名空间前缀无关） */
function extractXmlTexts(xml: string, localNames: string[]): string[] {
  const out: string[] = [];
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    for (const local of localNames) {
      for (const el of Array.from(doc.getElementsByTagName("*"))) {
        if (el.localName === local && el.textContent?.trim()) out.push(el.textContent.trim());
      }
    }
  } catch {
    for (const local of localNames) {
      const re = new RegExp(`<[^>]*:?${local}[\\s>][^]*?</[^>]*:?${local}>`, "g");
      for (const m of Array.from(xml.matchAll(re))) out.push(m[0].replace(/<[^>]+>/g, "").trim());
    }
  }
  return out.filter(Boolean);
}

const bytesToText = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** docx：word/document.xml 按 <w:p> 段落提取 */
async function extractDocx(blob: Blob): Promise<{ content?: string; note?: string }> {
  const entries = await parseZipEntries(blob);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) return { note: "docx 中未找到 word/document.xml（可能损坏）" };
  const xml = bytesToText(await doc.read());
  // 按段落 <w:p> 分组，段内拼接 <w:t>
  const paragraphs = xml.split(/<w:p[\s>]/).slice(1).map((seg) => {
    const texts = Array.from(seg.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)).map((m) => m[1]);
    return texts.join("").trim();
  }).filter(Boolean);
  const text = paragraphs.join("\n");
  if (!text.trim()) return { note: "docx 中未提取到文本内容" };
  return { content: text.length > MATERIAL_FILE_CHAR_LIMIT ? `${text.slice(0, MATERIAL_FILE_CHAR_LIMIT)}…` : text, ...(text.length > MATERIAL_FILE_CHAR_LIMIT ? { truncated: true } : {}) };
}

/** pptx：ppt/slides/slideN.xml 按 slide 顺序提取 */
async function extractPptx(blob: Blob): Promise<{ content?: string; note?: string }> {
  const entries = await parseZipEntries(blob);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => (parseInt(a.name.replace(/\D+/g, ""), 10) || 0) - (parseInt(b.name.replace(/\D+/g, ""), 10) || 0));
  if (!slides.length) return { note: "pptx 中未找到幻灯片内容" };
  const chunks: string[] = [];
  let chars = 0;
  for (const slide of slides) {
    const xml = bytesToText(await slide.read());
    const texts = extractXmlTexts(xml, ["t"]);
    if (!texts.length) continue;
    const joined = texts.join(" ");
    chunks.push(`【${slide.name.split("/").pop()}】${joined}`);
    chars += joined.length;
    if (chars > MATERIAL_FILE_CHAR_LIMIT) break;
  }
  const text = chunks.join("\n");
  if (!text.trim()) return { note: "pptx 中未提取到文本内容" };
  return { content: text.length > MATERIAL_FILE_CHAR_LIMIT ? `${text.slice(0, MATERIAL_FILE_CHAR_LIMIT)}…` : text, ...(chars > MATERIAL_FILE_CHAR_LIMIT ? { truncated: true } : {}) };
}

/** xlsx：共享字符串池粗提取 */
async function extractXlsx(blob: Blob): Promise<{ content?: string; note?: string }> {
  const entries = await parseZipEntries(blob);
  const shared = entries.find((e) => e.name === "xl/sharedStrings.xml");
  if (!shared) return { note: "xlsx 中未找到共享字符串表" };
  const xml = bytesToText(await shared.read());
  const texts = extractXmlTexts(xml, ["t"]);
  if (!texts.length) return { note: "xlsx 中未提取到文本内容" };
  const text = texts.join("\n");
  return { content: text.length > MATERIAL_FILE_CHAR_LIMIT ? `${text.slice(0, MATERIAL_FILE_CHAR_LIMIT)}…` : text, ...(text.length > MATERIAL_FILE_CHAR_LIMIT ? { truncated: true } : {}) };
}

/** odt/odp：content.xml 正文 */
async function extractOdf(blob: Blob): Promise<{ content?: string; note?: string }> {
  const entries = await parseZipEntries(blob);
  const content = entries.find((e) => e.name === "content.xml");
  if (!content) return { note: "ODF 文档中未找到 content.xml" };
  const xml = bytesToText(await content.read());
  const texts = extractXmlTexts(xml, ["p", "h"]);
  const text = texts.join("\n");
  if (!text.trim()) return { note: "ODF 文档中未提取到文本内容" };
  return { content: text.length > MATERIAL_FILE_CHAR_LIMIT ? `${text.slice(0, MATERIAL_FILE_CHAR_LIMIT)}…` : text, ...(text.length > MATERIAL_FILE_CHAR_LIMIT ? { truncated: true } : {}) };
}

/** zip：列出内部清单，并对文本类小文件递归提取（预算内） */
async function extractZipArchive(blob: Blob, name: string): Promise<{ content?: string; note?: string }> {
  let entries: ZipEntry[];
  try {
    entries = await parseZipEntries(blob);
  } catch {
    return { note: "压缩包解析失败（仅支持标准 zip，rar/7z 请先解压后上传）" };
  }
  if (!entries.length) return { note: "压缩包为空" };
  const lines: string[] = [`压缩包 ${name} 内含 ${entries.length} 个文件：`];
  let chars = lines[0].length;
  const textRe = /\.(txt|md|markdown|json|csv|log|xml|html|yml|yaml|py|ts|js|sql|ini|conf)$/i;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const line = `- ${entry.name}（${entry.size} 字节）`;
    lines.push(line);
    chars += line.length;
  }
  // 预算内提取文本类成员
  const members = entries.filter((e) => textRe.test(e.name) && e.size <= 200_000).slice(0, 20);
  for (const member of members) {
    if (chars >= MATERIAL_CONTEXT_CHAR_LIMIT / 2) break;
    try {
      const text = bytesToText(await member.read());
      const clipped = text.slice(0, 12_000);
      const block = `\n【压缩包内文件 ${member.name}】\n${clipped}${text.length > clipped.length ? "…" : ""}`;
      lines.push(block);
      chars += block.length;
    } catch {
      /* 跳过无法解压的成员 */
    }
  }
  const content = lines.join("\n");
  return { content: content.length > MATERIAL_FILE_CHAR_LIMIT * 2 ? `${content.slice(0, MATERIAL_FILE_CHAR_LIMIT * 2)}…` : content, ...(content.length > MATERIAL_FILE_CHAR_LIMIT * 2 ? { truncated: true } : {}) };
}

/** tar/gz：解压 + 512 字节头解析 */
async function extractTarGz(blob: Blob, name: string): Promise<{ content?: string; note?: string }> {
  try {
    let inner: Uint8Array;
    if (/\.tgz$|\.tar\.gz$/i.test(name)) {
      inner = await gunzip(new Uint8Array(await blob.arrayBuffer()));
      // tar 头解析
      const lines: string[] = [`tar 包 ${name} 内含文件：`];
      let pos = 0;
      const dv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
      while (pos + 512 <= inner.length) {
        const sizeField = bytesToText(inner.subarray(pos + 124, pos + 136)).replace(/\0.*$/, "").trim();
        const size = parseInt(sizeField, 8) || 0;
        const fname = bytesToText(inner.subarray(pos, pos + 100)).replace(/\0.*$/, "").trim();
        if (!fname) break;
        lines.push(`- ${fname}（${size} 字节）`);
        pos += 512 + Math.ceil(size / 512) * 512;
        if (lines.length > 100) break;
      }
      return { content: lines.join("\n") };
    }
    // 单文件 gz
    inner = await gunzip(new Uint8Array(await blob.arrayBuffer()));
    const innerName = name.replace(/\.gz$/i, "");
    return await extractMaterialContent({ name: innerName, size: inner.length, blob: new Blob([inner as BlobPart]) });
  } catch {
    return { note: "gz/tar.gz 解压失败" };
  }
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
    let dimension = "";
    try {
      const bitmap = await createImageBitmap(entry.blob);
      dimension = `，尺寸 ${bitmap.width}×${bitmap.height}`;
      bitmap.close();
    } catch {
      /* SVG 等无法解码时忽略 */
    }
    return { note: `图片文件（${(entry.blob.type || ext).toUpperCase()}${dimension}），AI 可结合文件名理解其用途；如需图片内容请人工补充文字描述` };
  }
  if (ext === "docx") {
    try {
      return await extractDocx(entry.blob);
    } catch {
      return { note: "docx 解析失败" };
    }
  }
  if (ext === "pptx") {
    try {
      return await extractPptx(entry.blob);
    } catch {
      return { note: "pptx 解析失败" };
    }
  }
  if (ext === "xlsx") {
    try {
      return await extractXlsx(entry.blob);
    } catch {
      return { note: "xlsx 解析失败" };
    }
  }
  if (ext === "odt" || ext === "odp" || ext === "ods") {
    try {
      return await extractOdf(entry.blob);
    } catch {
      return { note: "ODF 文档解析失败" };
    }
  }
  if (ext === "zip") {
    return await extractZipArchive(entry.blob, entry.name);
  }
  if (ext === "gz" || ext === "tgz" || /\.tar\.gz$/i.test(entry.name)) {
    return await extractTarGz(entry.blob, entry.name);
  }
  if (ext === "rar" || ext === "7z") {
    return { note: `.${ext} 为专有压缩格式，无法解析；请改用 zip 或解压后上传` };
  }
  if (["doc", "ppt", "xls"].includes(ext)) {
    return { note: `.${ext} 为旧版二进制 Office 格式，暂不支持自动提取正文；请另存为 .${ext}x 或 PDF 后上传` };
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
  const tree = await listMaterialsDir(path, 8); // 递归子目录，否则嵌套文件会被漏掉
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
