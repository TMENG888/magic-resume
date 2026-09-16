import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronRight, File, Folder, FolderOpen, HardDrive, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMaterialsStore } from "@/store/useMaterialsStore";
import { formatBytes, saveFilesToMaterials, screenUploadFiles } from "@/utils/materials";
import {
  createMaterialsAttachment,
  localFileAttachment,
  type MaterialAttachment,
} from "@/lib/material-context";
import { extensionOf } from "@/utils/materials";

interface MaterialPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (attachments: MaterialAttachment[]) => void;
  /** 允许选择整个文件夹（我的资料页签） */
  allowFolders?: boolean;
  title?: string;
}

/** 展开节点的相对路径，快速判断是否被排除 */
const isDescendant = (path: string, excluded: string[]) =>
  excluded.some((p) => path === p || path.startsWith(`${p}/`));

export function MaterialPickerDialog({
  open,
  onOpenChange,
  onConfirm,
  allowFolders = true,
  title,
}: MaterialPickerDialogProps) {
  const t = useTranslations("dashboard.agent");
  const tm = useTranslations("dashboard.materials");
  const { tree, loading, loaded, supported, refresh } = useMaterialsStore();

  const [selected, setSelected] = useState<MaterialAttachment[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(0); // >0 表示本地文件正在落盘（已保存个数）
  const localInputRef = useRef<HTMLInputElement>(null);
  const localFolderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setSelected([]);
      if (!loaded) void refresh();
    }
  }, [open, loaded, refresh]);

  // webkitdirectory 属性 React 不识别，需手动设置；由于 Dialog/Tabs 非激活时
  // 不渲染内容，必须用 ref callback 在 input 实际挂载时设置（useEffect [] 只会
  // 在首次挂载时跑一次，那时 input 尚不存在，属性会丢失 → 文件夹选择退化为文件选择）
  const attachFolderPicker = (el: HTMLInputElement | null) => {
    localFolderInputRef.current = el;
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  };

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleSelectMaterials = (node: {
    path: string;
    name: string;
    kind: "file" | "dir";
    size: number;
  }) => {
    setSelected((prev) => {
      const exists = prev.find((item) => item.source === "materials" && item.path === node.path);
      if (exists) return prev.filter((item) => item !== exists);
      // 若选择文件夹，移除其子节点；若选择文件，若其父文件夹已被选择则忽略
      let next = prev.filter((item) => {
        if (item.source !== "materials") return true;
        if (node.kind === "dir") return !(item.path === node.path || item.path.startsWith(`${node.path}/`));
        return !isDescendant(node.path, [item.path]);
      });
      next = [
        ...next,
        createMaterialsAttachment({
          source: "materials",
          path: node.path,
          name: node.name,
          kind: node.kind,
          size: node.size,
        }),
      ];
      return next;
    });
  };

  const isMaterialsSelected = (path: string) =>
    selected.some((item) => item.source === "materials" && item.path === path);

  // 大目录渲染保护：OPFS 里可能有上万文件，DOM 全量渲染会卡死浏览器（渲染上限 600 项）
  let renderBudget = 600;
  const renderTree = (nodes: ReturnType<typeof useMaterialsStore.getState>["tree"], depth = 0): React.ReactNode => {
    if (renderBudget <= 0) return null;
    const shown = nodes.slice(0, renderBudget);
    renderBudget -= shown.length;
    return (
      <>
        {shown.map((node) => {
      const isExpanded = expanded.has(node.path);
      const isSelected = isMaterialsSelected(node.path);
      const dirHasChildren = node.kind === "dir" && (node.children?.length ?? 0) > 0;
      return (
        <div key={node.path}>
          <div
            className={cn(
              "group flex items-center gap-1 rounded-lg pr-2 transition-colors",
              isSelected ? "bg-primary/10" : "hover:bg-muted/60",
            )}
            style={{ paddingLeft: depth * 16 + 4 }}
          >
            <button
              type="button"
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-transform",
                dirHasChildren ? "hover:bg-muted" : "invisible",
                isExpanded && "rotate-90",
              )}
              onClick={() => dirHasChildren && toggleExpand(node.path)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 shrink-0 accent-[hsl(var(--primary))]"
                checked={isSelected}
                onChange={() =>
                  toggleSelectMaterials({
                    path: node.path,
                    name: node.name,
                    kind: node.kind,
                    size: node.size,
                  })
                }
              />
              {node.kind === "dir" ? (
                isExpanded ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                )
              ) : (
                <File className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{node.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {node.kind === "dir"
                  ? `${node.children?.length ?? 0} 项`
                  : formatBytes(node.size)}
              </span>
            </label>
          </div>
          {node.kind === "dir" && isExpanded && node.children && (
            <div>{renderTree(node.children, depth + 1)}</div>
          )}
        </div>
        );
        })}
        {shown.length < nodes.length && (
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground/70">
            …{tm("listTruncated", { count: nodes.length - shown.length })}
          </div>
        )}
      </>
    );
  };

  /** 本地文件/文件夹统一落盘：写入「我的资料」库后仅保留路径引用（不持有 File 对象），
   *  发送时只注入路径清单，AI 按需用 read_material 读取内容 —— 避免大文件夹全量提取括爆内存 */
  const saveLocally = async (files: File[], onDone: (savedPaths: string[]) => void) => {
    const screen = screenUploadFiles(files);
    if (screen.blocked) {
      toast.error(screen.blocked);
      return;
    }
    if (screen.skippedLarge.length) {
      toast.warning(tm("uploadSkippedLarge", { count: screen.skippedLarge.length }));
    }
    if (!screen.accepted.length) return;
    setSaving(1);
    try {
      const result = await saveFilesToMaterials(screen.accepted, "本地上传", (done, total) =>
        setSaving(done + 1),
      );
      void refresh();
      if (result.saved.length) {
        toast.success(tm("savedToLibrary", { count: result.saved.length }));
      }
      if (result.failed.length) {
        toast.warning(tm("saveFailedCount", { count: result.failed.length }));
      }
      onDone(result.saved);
    } catch {
      toast.error(tm("saveFailed"));
      onDone([]);
    } finally {
      setSaving(0);
    }
  };

  const handleLocalFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    void saveLocally(list, (savedPaths) => {
      if (!savedPaths.length) return;
      const additions = savedPaths.map((path) =>
        createMaterialsAttachment({ source: "materials", path, name: path.split("/").pop() ?? path, kind: "file", size: 0 }),
      );
      setSelected((prev) => {
        const existing = new Set(prev.map((item) => `${item.source}:${item.path}`));
        return [...prev, ...additions.filter((item) => !existing.has(`${item.source}:${item.path}`))];
      });
    });
    if (localInputRef.current) localInputRef.current.value = "";
    if (localFolderInputRef.current) localFolderInputRef.current.value = "";
  };

  /** 本地文件夹：落盘后按顶层目录聚合为一个文件夹路径引用（保留目录结构，AI 按需读取） */
  const handleLocalFolder = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    const roots = new Set(
      list.map((file) => {
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        return relative.split("/")[0] || file.name;
      }),
    );
    void saveLocally(list, (savedPaths) => {
      if (!savedPaths.length) return;
      const additions = Array.from(roots).map((root) =>
        createMaterialsAttachment({ source: "materials", path: `本地上传/${root}`, name: root, kind: "dir", size: 0 }),
      );
      setSelected((prev) => {
        const existing = new Set(prev.map((item) => `${item.source}:${item.path}`));
        return [...prev, ...additions.filter((item) => !existing.has(`${item.source}:${item.path}`))];
      });
    });
    if (localFolderInputRef.current) localFolderInputRef.current.value = "";
  };

  const handleConfirm = () => {
    if (!selected.length) {
      toast.error(t("attachments"));
      return;
    }
    onConfirm(selected);
    onOpenChange(false);
  };

  const localTotal = useMemo(
    () => selected.filter((item) => item.path.startsWith("本地上传/")).length,
    [selected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] w-[min(560px,94vw)] max-w-[560px] flex-col rounded-2xl p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="text-base">{title ?? t("attachments")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("pickMaterials")} / {t("pickLocal")}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="materials" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 mt-3 grid w-auto grid-cols-2">
            <TabsTrigger value="materials" className="gap-1.5 text-xs">
              <Folder className="h-3.5 w-3.5" />
              {t("pickMaterials")}
            </TabsTrigger>
            <TabsTrigger value="local" className="gap-1.5 text-xs">
              <HardDrive className="h-3.5 w-3.5" />
              {t("pickLocal")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="materials" className="min-h-0 flex-1 px-3 pb-2 data-[state=active]:flex data-[state=active]:flex-col">
            {!supported ? (
              <div className="flex h-40 items-center justify-center px-8 text-center text-xs text-muted-foreground">
                {tm("unsupported")}
              </div>
            ) : loading && !loaded ? (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : tree.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
                <p className="text-sm text-muted-foreground">{tm("emptyTitle")}</p>
                <p className="max-w-[280px] text-xs text-muted-foreground/70">{tm("emptyDescription")}</p>
              </div>
            ) : (
              <ScrollArea className="h-[300px] pr-2 pt-2">
                <div className="space-y-0.5">
                  {renderTree(tree)}
                  {allowFolders && (
                    <p className="px-3 pb-2 pt-2 text-[10px] leading-relaxed text-muted-foreground/70">
                      {tm("emptyDescription")}
                    </p>
                  )}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="local" className="min-h-0 flex-1 px-5 pb-2 data-[state=active]:flex data-[state=active]:flex-col">
            <input
              ref={localInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleLocalFiles(e.target.files)}
            />
            <input
              ref={attachFolderPicker}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleLocalFolder(e.target.files)}
            />
            {/* 文件 / 文件夹双一等入口：文件夹附件保留目录结构，AI 按路径应用 */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/80 bg-muted/20 transition-colors hover:border-primary/50 hover:bg-primary/5"
                onClick={() => localInputRef.current?.click()}
              >
                <HardDrive className="h-6 w-6 text-muted-foreground/70" />
                <span className="text-[13px] font-medium text-foreground">{tm("uploadFile")}</span>
                <span className="text-[10px] text-muted-foreground">{tm("uploadFolderHint")}</span>
              </button>
              <button
                type="button"
                className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/80 bg-muted/20 transition-colors hover:border-primary/50 hover:bg-primary/5"
                onClick={() => localFolderInputRef.current?.click()}
              >
                <Folder className="h-6 w-6 text-amber-500/80" />
                <span className="text-[13px] font-medium text-foreground">{tm("uploadFolder")}</span>
                <span className="text-[10px] text-muted-foreground">{tm("keepFolderStructure")}</span>
              </button>
            </div>
            {saving > 0 && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {tm("savingToLibrary", { done: Math.max(0, saving - 1) })}
              </div>
            )}
            {localTotal > 0 && saving === 0 && (
              <ScrollArea className="mt-2 h-[120px] shrink-0 rounded-xl border border-border/60 bg-muted/20 p-2">
                <div className="space-y-1">
                  {selected
                    .filter((item) => item.path.startsWith("本地上传/"))
                    .map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs hover:bg-muted/40">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {item.kind === "dir" ? (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                          ) : (
                            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{item.path}</span>
                        </span>
                        <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                          {tm("savedAsRef")}
                        </span>
                      </div>
                    ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="items-center justify-between gap-2 border-t border-border/60 px-5 py-3.5 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {t("attachments")}：{selected.length}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 rounded-lg" onClick={() => onOpenChange(false)}>
              {tm("cancel")}
            </Button>
            <Button size="sm" className="h-8 rounded-lg" onClick={handleConfirm} disabled={!selected.length || saving > 0}>
              {tm("confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 附件 chips 列表（输入区上方展示） */
export function AttachmentChips({
  attachments,
  onRemove,
  compact,
}: {
  attachments: MaterialAttachment[];
  onRemove?: (id: string) => void;
  compact?: boolean;
}) {
  if (!attachments.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", compact ? "max-h-20 overflow-y-auto" : "")}>
      {attachments.map((item) => {
        const ext = extensionOf(item.name);
        return (
          <span
            key={item.id}
            className={cn(
              "inline-flex max-w-[240px] items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0.5 pl-2 pr-1 text-[11px] text-foreground/80",
            )}
            title={item.source === "materials" ? item.path : item.name}
          >
            {item.kind === "dir" ? (
              <Folder className="h-3 w-3 shrink-0 text-amber-500" />
            ) : (
              <File className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">
              {item.kind === "dir" ? item.name : item.name}
              {item.source === "materials" && (
                <span className="ml-1 rounded-sm bg-primary/10 px-1 text-[9px] text-primary">资料</span>
              )}
            </span>
            {onRemove && (
              <button
                type="button"
                className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onRemove(item.id)}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

export { localFileAttachment };
