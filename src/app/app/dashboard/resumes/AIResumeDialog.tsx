import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Sparkles, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAIConfigStore } from "@/store/useAIConfigStore";
import { getTaskModel, toAIConnection } from "@/config/ai-models";
import { MaterialPickerDialog, AttachmentChips } from "@/components/shared/materials/MaterialPickerDialog";
import type { MaterialAttachment } from "@/lib/material-context";
import { buildMaterialContextBlock } from "@/lib/material-context";

interface AIResumeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerated: (result: Record<string, unknown>) => void;
}

export function AIResumeDialog({ open, onOpenChange, onGenerated }: AIResumeDialogProps) {
  const t = useTranslations("dashboard.resumes.aiDialog");
  const router = useRouter();
  const aiConfig = useAIConfigStore();
  const textModel = getTaskModel(aiConfig, "text");
  const configured = !!(textModel && textModel.apiKey.trim() && textModel.model.trim());

  const [jd, setJd] = useState("");
  const [extra, setExtra] = useState("");
  const [attachments, setAttachments] = useState<MaterialAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!open) {
      setGenerating(false);
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!jd.trim()) {
      toast.error(t("jdRequired"));
      return;
    }
    if (!configured || !textModel) {
      toast.error(t("modelLabel"));
      router.push("/app/dashboard/ai");
      return;
    }
    setGenerating(true);
    try {
      const materialContext = await buildMaterialContextBlock(attachments, { totalCharLimit: 60_000 });
      const response = await fetch("/api/resume-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection: toAIConnection(textModel),
          jd: jd.trim(),
          extraRequirements: extra.trim(),
          materialContext,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? response.status;
        throw new Error(String(code));
      }
      const payload = (await response.json()) as { resume: Record<string, unknown>; warnings?: string[] };
      if (!payload.resume) throw new Error("invalidOutput");
      toast.success(t("success"));
      onOpenChange(false);
      onGenerated(payload.resume);
    } catch (error) {
      console.error(error);
      toast.error(`${t("failed")}${error instanceof Error && error.message ? `（${error.message}）` : ""}`);
    } finally {
      setGenerating(false);
    }
  };

  const modelLabel = useMemo(() => (textModel ? textModel.name || textModel.model : ""), [textModel]);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !generating && onOpenChange(next)}>
        <DialogContent className="w-[min(640px,94vw)] max-w-[640px] rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="border-b border-border/60 px-6 py-5">
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 text-white">
                <Wand2 className="h-4 w-4" />
              </span>
              {t("title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-relaxed">
              {t("description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 px-6 py-5">
            {/* JD */}
            <div className="space-y-2">
              <Label htmlFor="ai-jd" className="text-xs font-medium">
                {t("jdLabel")}
              </Label>
              <Textarea
                id="ai-jd"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                placeholder={t("jdPlaceholder")}
                className="min-h-[140px] resize-y rounded-xl border-border/80 bg-muted/20 text-[13px] leading-relaxed"
              />
            </div>

            {/* 补充要求 */}
            <div className="space-y-2">
              <Label htmlFor="ai-extra" className="text-xs font-medium">
                {t("extraLabel")}
              </Label>
              <Textarea
                id="ai-extra"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder={t("extraPlaceholder")}
                className="min-h-[64px] resize-y rounded-xl border-border/80 bg-muted/20 text-[13px]"
              />
            </div>

            {/* 资料 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">{t("materialsLabel")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-lg text-xs"
                  onClick={() => setPickerOpen(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("addMaterials")}
                </Button>
              </div>
              {attachments.length ? (
                <AttachmentChips
                  attachments={attachments}
                  onRemove={(id) => setAttachments((prev) => prev.filter((item) => item.id !== id))}
                />
              ) : (
                <p className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
                  {t("materialsHint")}
                </p>
              )}
            </div>

            {/* 模型 */}
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 px-3.5 py-2.5">
              <span className="text-xs text-muted-foreground">{t("modelLabel")}</span>
              {configured ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {modelLabel}
                </span>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  onClick={() => router.push("/app/dashboard/ai")}
                >
                  {t("configureModel")}
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-4">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={generating}>
              取消
            </Button>
            <Button
              onClick={() => void handleGenerate()}
              disabled={generating || !jd.trim() || !configured}
              className="min-w-[128px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500"
            >
              {generating ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  {t("generating")}
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  {t("generate")}
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <MaterialPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={(selected) => setAttachments((prev) => [...prev, ...selected])}
      />
    </>
  );
}

export default AIResumeDialog;
