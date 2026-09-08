import { create } from "zustand";
import {
  collectStats,
  isOPFSAvailable,
  listMaterialsTree,
  type MaterialNode,
  type MaterialStats,
} from "@/utils/materials";

interface MaterialsState {
  supported: boolean;
  tree: MaterialNode[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  version: number;
  stats: MaterialStats;
  refresh: () => Promise<void>;
  invalidate: () => void;
}

export const useMaterialsStore = create<MaterialsState>()((set, get) => ({
  supported: isOPFSAvailable(),
  tree: [],
  loading: false,
  loaded: false,
  error: null,
  version: 0,
  stats: { fileCount: 0, dirCount: 0, totalSize: 0 },

  refresh: async () => {
    if (!get().supported) return;
    set({ loading: true, error: null });
    try {
      const tree = await listMaterialsTree();
      set({
        tree,
        loading: false,
        loaded: true,
        version: get().version + 1,
        stats: collectStats(tree),
      });
    } catch (error) {
      set({
        loading: false,
        loaded: true,
        error: error instanceof Error ? error.message : "加载资料失败",
      });
    }
  },

  invalidate: () => {
    void get().refresh();
  },
}));
