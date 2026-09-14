import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentTurn } from "@/lib/agent/agentClient";
import type { MaterialAttachment } from "@/lib/material-context";
import { createIDBStorage } from "./idbStorage";

export interface AgentChatItem {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice";
  content: string;
  tool?: string;
  toolOk?: boolean;
  toolSummary?: string;
}

const generateId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

/** 气泡数量上限，防止极端长会话无限增长 */
const MAX_ITEMS = 200;

type PersistedAgentChatState = Pick<
  AgentChatState,
  "items" | "turns" | "sessionId" | "input" | "attachments"
>;

interface AgentChatState {
  /** 对话气泡（持久化：缩放 remount / 刷新页面均不丢） */
  items: AgentChatItem[];
  /** 发送给模型的回合历史（持久化） */
  turns: AgentTurn[];
  /** 会话 id：同一会话多次回合共享，用于日志归组（持久化） */
  sessionId: string;
  /** 输入框草稿（持久化） */
  input: string;
  /** 待发送附件（持久化） */
  attachments: MaterialAttachment[];

  /** 是否正在生成（内存，不持久化） */
  running: boolean;
  /** 当前执行的工具名（内存） */
  currentTool: string | null;
  /** 进行中请求的控制器（内存，不可序列化） */
  abortController: AbortController | null;

  pushItem: (item: AgentChatItem) => void;
  appendTurns: (turns: AgentTurn[]) => void;
  setRunning: (running: boolean) => void;
  setCurrentTool: (tool: string | null) => void;
  setInput: (input: string) => void;
  setAttachments: (
    value:
      | MaterialAttachment[]
      | ((prev: MaterialAttachment[]) => MaterialAttachment[])
  ) => void;
  setAbortController: (controller: AbortController | null) => void;
  /** 中止当前请求（若有）并复位生成状态 */
  abort: () => void;
  /** 清空对话并开启新会话 */
  newSession: () => void;
}

/**
 * PI 智能体对话状态（全局 store）。
 *
 * 对话记录原来存放在 AgentPanel 组件的本地 useState 中，任何导致面板
 * remount 的布局变化（如浏览器缩放触发 workbench 的面板组 key 变化）
 * 都会让整个对话消失。提升为模块级 store 后 remount 不再丢数据，
 * 并通过 idbStorage 持久化，刷新页面后对话同样可恢复。
 */
export const useAgentChatStore = create<AgentChatState>()(
  persist<AgentChatState, [], [], PersistedAgentChatState>(
    (set, get) => ({
      items: [],
      turns: [],
      sessionId: generateId(),
      input: "",
      attachments: [],
      running: false,
      currentTool: null,
      abortController: null,

      pushItem: (item) =>
        set((state) => ({
          items: [...state.items, item].slice(-MAX_ITEMS),
        })),
      appendTurns: (turns) =>
        set((state) => ({ turns: [...state.turns, ...turns] })),
      setRunning: (running) => set({ running }),
      setCurrentTool: (currentTool) => set({ currentTool }),
      setInput: (input) => set({ input }),
      setAttachments: (value) =>
        set((state) => ({
          attachments:
            typeof value === "function" ? value(state.attachments) : value,
        })),
      setAbortController: (abortController) => set({ abortController }),
      abort: () => {
        get().abortController?.abort();
        set({ abortController: null, running: false, currentTool: null });
      },
      newSession: () => {
        get().abort();
        set({
          items: [],
          turns: [],
          sessionId: generateId(),
          input: "",
          attachments: [],
        });
      },
    }),
    {
      name: "agent-chat-storage",
      storage: createIDBStorage<PersistedAgentChatState>({
        legacyLocalStorageKey: "agent-chat-storage",
      }),
      partialize: (state): PersistedAgentChatState => ({
        items: state.items,
        turns: state.turns,
        sessionId: state.sessionId,
        input: state.input,
        attachments: state.attachments,
      }),
    }
  )
);
