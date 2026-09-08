import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  ChevronRight,
  Download,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  FolderUp,
} from "lucide-react";
import { useTranslations } from "@/i18n/compat/client";
import { useMaterialsStore } from "@/store/useMaterialsStore";
import {
  createMaterialsFolder,
  deleteMaterialsNode,
  downloadMaterialsFile,
  extensionOf,
  formatBytes,
  isArchiveFile,
  isImageFile,
  isTextLikeFile,
  parentPath,
  readMaterialsFileBlob,
  readMaterialsFileText,
  renameMaterialsNode,
  saveFilesToMaterials,
  type MaterialNode,
} from "@/utils/materials";
import { cn } from "@/lib/utils";

const getNodeType = (node: { name: string; kind: "file" | "dir" }) => {
  if (node.kind === "dir") return "dir" as const;
  const ext = extensionOf(node.name);
  if (isImageFile(node.name)) return "image" as const;
  if (isArchiveFile(node.name)) return "archive" as const;
  if (ext === "pdf") return "pdf" as const;
  if (isTextLikeFile(node.name)) return "text" as const;
  if (["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(ext)) return "office" as const;
  return "binary" as const;
};

const NodeIcon = ({ node, className }: { node: { name: string; kind: "file" | "dir" }; className?: string }) => {
  const type = getNodeType(node);
  if (node.kind === "dir") return <Folder className={cn("h-5 w-5 text-amber-500", className)} />;
  switch (type) {
    case "image":
      return <FileImage className={cn("h-5 w-5 text-sky-500", className)} />;
    case "archive":
      return <FileArchive className={cn("h-5 w-5 text-orange-500", className)} />;
    case "pdf":
      return <FileType2 className={cn("h-5 w-5 text-red-500", className)} />;
    case "text":
      return <FileText className={cn("h-5 w-5 text-blue-500", className)} />;
    case "office":
      return <FileCode2 className={cn("h-5 w-5 text-indigo-500", className)} />;
    default:
      return <FileText className={cn("h-5 w-5 text-muted-foreground", className)} />;
  }
};

export default function MaterialsPage() {
  const t = useTranslations("dashboard.materials");
  const { tree, loading, loaded, supported, stats, refresh } = useMaterialsStore();

  const [currentPath, setCurrentPath] = useState("");
  const [renameTarget, setRenameTarget] = useState<MaterialNode | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MaterialNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // webkitdirectory 属性 React 不识别，手动设置
    const input = folderInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
  }, []);

  const currentNodes = useMemo(() => {
    if (!currentPath) return tree;
    const segments = currentPath.split("/");
    let list = tree;
    for (const segment of segments) {
      const found = list.find((node) => node.kind === "dir" && node.name === segment);
      if (!found?.children) return [];
      list = found.children;
    }
    return list;
  }, [tree, currentPath]);

  const breadcrumbs = useMemo(() => currentPath ? currentPath.split("/") : [], [currentPath]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const saved = await saveFilesToMaterials(Array.from(files), currentPath);
      toast.success(t("uploaded", { count: saved.length }));
      await refresh();
    } catch (error) {
      console.error(error);
      toast.error(t("uploadFailed"));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }, [currentPath, refresh, t]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createMaterialsFolder(currentPath, name);
      toast.success(t("created"));
      setNewFolderOpen(false);
      setNewFolderName("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    setBusy(true);
    try {
      await renameMaterialsNode(renameTarget.path, renameValue);
      toast.success(t("renamed"));
      setRenameTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteMaterialsNode(deleteTarget.path);
      toast.success(t("deleted"));
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async (node: MaterialNode) => {
    const type = getNodeType(node);
    if (type === "image") {
      try {
        const blob = await readMaterialsFileBlob(node.path);
        const url = URL.createObjectURL(blob);
        setPreview({ name: node.name, text: `__IMAGE__${url}` });
        return;
      } catch {
        toast.error(t("operationFailed"));
        return;
      }
    }
    if (type !== "text" && type !== "pdf") {
      toast.info(t("previewTextOnly"));
      return;
    }
    setPreviewLoading(true);
    try {
      if (type === "pdf") {
        const blob = await readMaterialsFileBlob(node.path);
        const url = URL.createObjectURL(blob);
        setPreview({ name: node.name, text: `__PDF__${url}` });
        return;
      }
      const text = await readMaterialsFileText(node.path, 20_000);
      setPreview({ name: node.name, text });
    } catch {
      toast.error(t("operationFailed"));
    } finally {
      setPreviewLoading(false);
    }
  };

  const statusText = stats.fileCount
    ? t("statusPill", {
        files: stats.fileCount,
        dirs: stats.dirCount,
        size: formatBytes(stats.totalSize),
      })
    : t("statusEmpty");

  return (
    <div className="relative mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute -top-20 left-1/2 -z-10 h-72 w-full max-w-4xl -translate-x-1/2 opacity-40 blur-3xl [background:radial-gradient(ellipse_at_top,_hsl(var(--primary)/0.08),_transparent_70%)]" />

      {/* Header */}
      <header className="mb-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-md mb-2.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]" />
          <span>{statusText}</span>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-serif font-medium tracking-tight text-foreground sm:text-4xl">
              {t("title")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground leading-relaxed">
              {t("subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleUpload(e.target.files)}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleUpload(e.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-lg gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={!supported || busy}
            >
              <Upload className="h-4 w-4" />
              {t("uploadFile")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-lg gap-1.5"
              onClick={() => folderInputRef.current?.click()}
              disabled={!supported || busy}
            >
              <FolderUp className="h-4 w-4" />
              {t("uploadFolder")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-lg gap-1.5"
              onClick={() => setNewFolderOpen(true)}
              disabled={!supported || busy}
            >
              <FolderPlus className="h-4 w-4" />
              {t("newFolder")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-lg"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </header>

      {!supported ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center text-sm text-destructive">
          {t("unsupported")}
        </div>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-border/80 bg-card/40 shadow-[0_4px_24px_rgba(0,0,0,0.03)] backdrop-blur-md transition-all">
          {/* Breadcrumb bar */}
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  {breadcrumbs.length ? (
                    <BreadcrumbLink
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                      onClick={() => setCurrentPath("")}
                    >
                      {t("breadcrumbRoot")}
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{t("breadcrumbRoot")}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {breadcrumbs.map((segment, index) => {
                  const isLast = index === breadcrumbs.length - 1;
                  const target = breadcrumbs.slice(0, index + 1).join("/");
                  return (
                    <BreadcrumbItem key={target}>
                      <BreadcrumbSeparator />
                      {isLast ? (
                        <BreadcrumbPage>{segment}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                          onClick={() => setCurrentPath(target)}
                        >
                          {segment}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
            <span className="text-xs text-muted-foreground">
              {currentNodes.length} {t("items")}
            </span>
          </div>

          {/* File list */}
          <ScrollArea className="h-[calc(100vh-21rem)] min-h-[320px]">
            <div className="p-3">
              {loaded && currentNodes.length === 0 ? (
                <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-center">
                  <div className="rounded-full bg-muted/60 p-4">
                    <Folder className="h-8 w-8 text-muted-foreground/60" />
                  </div>
                  <p className="mt-2 text-sm font-medium text-foreground">
                    {currentPath ? t("folderEmpty") : t("emptyTitle")}
                  </p>
                  <p className="max-w-sm text-xs text-muted-foreground">{t("emptyDescription")}</p>
                  {!currentPath && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 rounded-lg"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-1.5 h-4 w-4" />
                      {t("uploadFile")}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {breadcrumbs.length > 0 && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                      onClick={() => setCurrentPath(parentPath(currentPath))}
                    >
                      <ChevronRight className="h-4 w-4 rotate-180" />
                      <span>..</span>
                    </button>
                  )}
                  {currentNodes.map((node, index) => (
                    <motion.div
                      key={node.path}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.3) }}
                      className={cn(
                        "group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
                        "hover:bg-muted/60",
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => {
                          if (node.kind === "dir") setCurrentPath(node.path);
                          else void handlePreview(node);
                        }}
                      >
                        <NodeIcon node={node} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {node.name}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {node.kind === "dir"
                              ? `${node.children?.length ?? 0} ${t("items")}`
                              : formatBytes(node.size)}
                          </span>
                        </span>
                        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                          {node.updatedAt
                            ? new Date(node.updatedAt).toLocaleString(undefined, {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          {node.kind === "dir" && (
                            <DropdownMenuItem onClick={() => setCurrentPath(node.path)}>
                              <Folder className="mr-2 h-4 w-4" />
                              {t("open")}
                            </DropdownMenuItem>
                          )}
                          {node.kind === "file" && (
                            <DropdownMenuItem onClick={() => void handlePreview(node)}>
                              <FileText className="mr-2 h-4 w-4" />
                              {t("preview")}
                            </DropdownMenuItem>
                          )}
                          {node.kind === "file" && (
                            <DropdownMenuItem onClick={() => void downloadMaterialsFile(node.path)}>
                              <Download className="mr-2 h-4 w-4" />
                              {t("download")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => {
                              setRenameTarget(node);
                              setRenameValue(node.name);
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            {t("rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(node)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t("delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </motion.div>
                  ))}
                </div>
              )}
              {loading && !loaded && (
                <div className="flex min-h-[280px] items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </ScrollArea>
        </section>
      )}

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={t("namePlaceholder")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleRename()} disabled={busy || !renameValue.trim()}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New folder dialog */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t("newFolderTitle")}</DialogTitle>
            <DialogDescription className="truncate text-xs text-muted-foreground">
              /{currentPath}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder={t("namePlaceholder")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleCreateFolder()} disabled={busy || !newFolderName.trim()}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmDescription", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview dialog */}
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex max-h-[85vh] w-[min(760px,92vw)] max-w-[760px] flex-col rounded-2xl p-0">
          <DialogHeader className="border-b border-border/60 px-5 py-3.5">
            <DialogTitle className="truncate text-sm font-semibold">{preview?.name}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            {preview?.text.startsWith("__IMAGE__") ? (
              <div className="flex items-center justify-center p-6">
                <img src={preview.text.slice("__IMAGE__".length)} alt={preview.name} className="max-h-[60vh] rounded-lg object-contain" />
              </div>
            ) : preview?.text.startsWith("__PDF__") ? (
              <iframe
                src={preview.text.slice("__PDF__".length)}
                title={preview.name}
                className="h-[70vh] w-full border-0"
              />
            ) : (
              <pre className="whitespace-pre-wrap break-all p-5 text-xs leading-relaxed text-foreground/90">
                {preview?.text}
              </pre>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
