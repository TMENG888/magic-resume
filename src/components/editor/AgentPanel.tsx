import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import {
  Bot,
  Check,
  ChevronRight,
  Eraser,
  Folder,
  File,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Wrench,
  X,
  AlertCircle,
  Info,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useResumeStore } from "@/store/useResumeStore";
import { useAIConfigStore } from "@/store/useAIConfigStore";
import { useAgentChatStore } from "@/store/useAgentChatStore";
import { getTaskModel, toAIConnection } from "@/config/ai-models";
import { MaterialPickerDialog, AttachmentChips } from "@/components/shared/materials/MaterialPickerDialog";
import { runAgentTurn, type AgentTurn } from "@/lib/agent/agentClient";

const TOOL_LABELS: Record<string, string> = {
  get_resume: "读取简历",
  update_resume: "更新简历",
  list_resume_sections: "读取模块",
  toggle_resume_section: "模块显隐",
  set_resume_theme: "主题设置",
  list_materials: "列出我的资料",
  read_material: "读取资料",
};

/** 轻量 Markdown 渲染（加粗 / 行内代码 / 列表 / 标题） */
const renderMarkdownLite = (text: string) => {
  const lines = text.split(/\r?\n/);
  const nodes: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = (key: string) => {
    if (!listBuffer.length) return;
    nodes.push(
      <ul key={key} className="my-1 ml-4 list-disc space-y-1">
        {listBuffer.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  const renderInline = (text: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
      const token = match[0];
      if (token.startsWith("**")) {
        parts.push(<strong key={key++} className="font-semibold">{token.slice(2, -2)}</strong>);
      } else {
        parts.push(
          <code key={key++} className="rounded bg-muted px-1 py-0.5 text-[11px]">{token.slice(1, -1)}</code>,
        );
      }
      lastIndex = match.index + token.length;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^[-*•]\s+/.test(trimmed)) {
      listBuffer.push(trimmed.replace(/^[-*•]\s+/, ""));
      return;
    }
    flushList(`list-${index}`);
    if (!trimmed) return;
    if (/^#{1,6}\s/.test(trimmed)) {
      nodes.push(
        <p key={index} className="mt-2 mb-1 text-[13px] font-semibold text-foreground">
          {renderInline(trimmed.replace(/^#{1,6}\s/, ""))}
        </p>,
      );
      return;
    }
    nodes.push(
      <p key={index} className="my-0.5 leading-relaxed">
        {renderInline(line)}
      </p>,
    );
  });
  flushList("list-final");
  return nodes;
};

const generateId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("dashboard.agent");
  const { activeResume } = useResumeStore();
  const aiConfig = useAIConfigStore();
  const textModel = getTaskModel(aiConfig, "text");
  const connectionConfigured = !!(textModel && textModel.apiKey.trim() && textModel.model.trim());

  // 对话状态全部来自全局 store：面板 remount（如浏览器缩放触发布局重建）不再丢记录，
  // 且经 idbStorage 持久化，刷新页面后对话同样可恢复
  const items = useAgentChatStore((s) => s.items);
  const turns = useAgentChatStore((s) => s.turns);
  const sessionId = useAgentChatStore((s) => s.sessionId);
  const input = useAgentChatStore((s) => s.input);
  const attachments = useAgentChatStore((s) => s.attachments);
  const running = useAgentChatStore((s) => s.running);
  const currentTool = useAgentChatStore((s) => s.currentTool);
  const pushItem = useAgentChatStore((s) => s.pushItem);
  const appendTurns = useAgentChatStore((s) => s.appendTurns);
  const setRunning = useAgentChatStore((s) => s.setRunning);
  const setCurrentTool = useAgentChatStore((s) => s.setCurrentTool);
  const setInput = useAgentChatStore((s) => s.setInput);
  const setAttachments = useAgentChatStore((s) => s.setAttachments);
  const setAbortController = useAgentChatStore((s) => s.setAbortController);
  const abort = useAgentChatStore((s) => s.abort);
  const newSession = useAgentChatStore((s) => s.newSession);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 面板宽度上报给 CSS 变量，供 PreviewDock 等固定悬浮元素避让（无遮挡交互）
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty("--agent-panel-width", `${el.offsetWidth}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty("--agent-panel-width", "0px");
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [items, running, currentTool, scrollToBottom]);

  const handleSend = async () => {
    const message = input.trim();
    if (!message || running) return;
    if (!connectionConfigured || !textModel) {
      toast.error(t("modelNotConfigured"));
      return;
    }

    pushItem({ id: generateId(), kind: "user", content: message });
    setInput("");
    setRunning(true);
    setCurrentTool(null);

    const controller = new AbortController();
    setAbortController(controller);

    let finalTurns: AgentTurn[] = [];
    try {
      await runAgentTurn({
        history: turns,
        userMessage: message,
        attachments,
        connection: toAIConnection(textModel),
        resumeTitle: activeResume?.title ?? "未命名简历",
        signal: controller.signal,
        sessionId,
        onEvent: (event) => {
          switch (event.type) {
            case "tool_start":
              setCurrentTool(event.tool);
              break;
            case "tool_result": {
              setCurrentTool(null);
              pushItem({
                id: generateId(),
                kind: "tool",
                content: event.tool,
                tool: event.tool,
                toolOk: event.ok,
                toolSummary: event.summary,
              });
              break;
            }
            case "final": {
              pushItem({ id: generateId(), kind: "assistant", content: event.reply });
              finalTurns = [
                { role: "assistant", content: JSON.stringify({ reply: event.reply }) },
              ];
              setCurrentTool(null);
              break;
            }
            case "notice": {
              pushItem({ id: generateId(), kind: "notice", content: event.message });
              break;
            }
            case "error": {
              pushItem({ id: generateId(), kind: "assistant", content: `⚠️ ${event.message}` });
              setCurrentTool(null);
              break;
            }
            default:
              break;
          }
        },
      });
    } catch (error) {
      toast.error(t("error"));
    } finally {
      // 将本轮完整对话（用户 + 最终回复）压入历史
      const fallbackTurn: AgentTurn = {
        role: "assistant",
        content: JSON.stringify({ reply: "（本轮未产生回复）" }),
      };
      const userTurn: AgentTurn = { role: "user", content: message };
      appendTurns([
        userTurn,
        ...(finalTurns.length ? finalTurns : [fallbackTurn]),
      ]);
      setAttachments([]);
      setRunning(false);
      setCurrentTool(null);
      setAbortController(null);
    }
  };

  const handleClear = () => {
    newSession();
  };

  // 停止当前生成（无轮次上限，用户随时可中止）
  const handleStop = () => {
    abort();
  };

  const modelLabel = useMemo(() => {
    if (!textModel) return t("modelNotConfigured");
    return `${textModel.name || textModel.model}`;
  }, [textModel, t]);

  return (
    <>
      <motion.aside
        ref={panelRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="flex h-full w-full min-w-0 flex-col bg-background"
      >
            {/* 面板头 */}
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 text-white shadow-sm">
                  <Bot className="h-4.5 w-4.5" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background bg-emerald-500" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    {t("title")}
                    <Sparkles className="h-3 w-3 text-violet-500" />
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">{t("subtitle")}</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleClear}>
                        <Eraser className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("clear")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("close")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>

            {/* 模型状态条 */}
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-1.5 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", connectionConfigured ? "bg-emerald-500" : "bg-amber-500")} />
                <span className="truncate">{modelLabel}</span>
              </div>
              {!connectionConfigured && (
                <a href="/app/dashboard/ai" className="shrink-0 text-primary hover:underline">
                  {t("goConfigure")}
                </a>
              )}
            </div>

            {/* 消息区 */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {items.length === 0 && !running ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/10">
                    <Bot className="h-6 w-6 text-violet-500" />
                  </div>
                  <p className="max-w-[300px] text-xs leading-relaxed text-muted-foreground">{t("welcome")}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map((item) => {
                    if (item.kind === "user") {
                      return (
                        <div key={item.id} className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13px] leading-relaxed text-primary-foreground shadow-sm">
                            {item.content}
                          </div>
                        </div>
                      );
                    }
                    if (item.kind === "notice") {
                      return (
                        <div key={item.id} className="flex justify-center">
                          <div className="inline-flex max-w-[92%] items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                            <Info className="h-3 w-3" />
                            <span>{item.content}</span>
                          </div>
                        </div>
                      );
                    }
                    if (item.kind === "tool") {
                      return (
                        <div key={item.id} className="flex justify-center">
                          <div
                            className={cn(
                              "inline-flex max-w-[92%] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                              item.toolOk
                                ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-400"
                                : "border-destructive/25 bg-destructive/8 text-destructive",
                            )}
                            title={item.toolSummary}
                          >
                            {item.toolOk ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                            <Wrench className="h-3 w-3" />
                            <span className="font-medium">{TOOL_LABELS[item.tool ?? item.content] ?? item.tool}</span>
                            {item.toolSummary && (
                              <span className="max-w-[220px] truncate text-[10px] opacity-70">{item.toolSummary.split("\n")[0]}</span>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={item.id} className="flex justify-start">
                        <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-border/70 bg-muted/40 px-3.5 py-2 text-[13px] text-foreground">
                          {renderMarkdownLite(item.content)}
                        </div>
                      </div>
                    );
                  })}
                  {running && (
                    <div className="flex justify-start">
                      <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-muted/40 px-3.5 py-2 text-[12px] text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {currentTool
                          ? t("toolRunning", { tool: TOOL_LABELS[currentTool] ?? currentTool })
                          : t("thinking")}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 输入区 */}
            <div className="border-t border-border/70 p-3">
              {attachments.length > 0 && (
                <div className="mb-2">
                  <AttachmentChips
                    attachments={attachments}
                    onRemove={(id) => setAttachments((prev) => prev.filter((item) => item.id !== id))}
                    compact
                  />
                </div>
              )}
              <div className="relative rounded-xl border border-border bg-muted/30 transition-colors focus-within:border-primary/50">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={t("placeholder")}
                  className="min-h-[64px] max-h-[140px] resize-none border-0 bg-transparent px-3 py-2.5 pr-20 text-[13px] shadow-none focus-visible:ring-0"
                  disabled={running}
                />
                <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-lg"
                          onClick={() => setPickerOpen(true)}
                          disabled={running}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t("pickMaterials")} / {t("pickLocal")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Button
                    size="icon"
                    className="h-7 w-7 rounded-lg"
                    onClick={() => (running ? handleStop() : void handleSend())}
                    disabled={!running && !input.trim()}
                    title={running ? t("stop") : undefined}
                  >
                    {running ? <Square className="h-3 w-3 fill-current" /> : <Send className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
          </motion.aside>

      <MaterialPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={(selected) => setAttachments((prev) => [...prev, ...selected])}
      />
    </>
  );
}

/** 右侧边缘的悬浮开关（面板收起时显示） */
export function AgentPanelHandle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslations("dashboard.agent");
  return (
    <AnimatePresence>
      {!open && (
        <motion.button
          key="agent-handle"
          type="button"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          onClick={onToggle}
          className={cn(
            "group fixed bottom-28 right-0 z-30 flex h-24 w-9 items-center justify-center",
            "rounded-l-xl border border-r-0 border-border bg-background/95 shadow-[-6px_0_20px_-8px_rgba(0,0,0,0.2)] backdrop-blur",
            "transition-colors hover:bg-violet-500/10",
          )}
          title={t("openAgent")}
        >
          <span className="flex flex-col items-center gap-1.5 text-violet-500">
            <Bot className="h-4 w-4" />
            <span className="text-[10px] font-medium tracking-wide [writing-mode:vertical-rl]">PI</span>
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

export default AgentPanel;
