import { get, set, del } from "idb-keyval";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface IDBStorageOptions {
  /**
   * 一次性迁移：首次读取时若 IndexedDB 中无该 key 的数据，
   * 则从 localStorage 读取旧数据（zustand createJSONStorage 写入的
   * `{ state, version }` JSON 格式），写入 IndexedDB 成功后再删除旧 key。
   */
  legacyLocalStorageKey?: string;
}

const warnedFailures = new Set<string>();

const warnFailure = (action: string, name: string, error: unknown) => {
  const key = `${action}:${name}`;
  if (warnedFailures.has(key)) return;
  warnedFailures.add(key);
  console.warn(
    `[idb-storage] Failed to ${action} "${name}" in IndexedDB. Changes remain available in memory for this session.`,
    error
  );
};

const hasIndexedDB = () =>
  typeof window !== "undefined" && typeof indexedDB !== "undefined";

/**
 * 基于 IndexedDB（idb-keyval）的 zustand persist 存储适配器。
 *
 * - 容量数百 MB，避免简历含 base64 图片时触发 localStorage 的 5MB 配额限制
 * - 服务端（SSR）或无 IndexedDB 环境返回 undefined，zustand 会自动跳过持久化
 * - 直接实现 PersistStorage 接口，利用结构化克隆存储对象，无 JSON 序列化开销
 */
export function createIDBStorage<T>(
  options?: IDBStorageOptions
): PersistStorage<T> | undefined {
  if (!hasIndexedDB()) {
    return undefined;
  }

  return {
    getItem: async (name) => {
      try {
        let value = await get<StorageValue<T>>(name);
        if (
          value === undefined &&
          options?.legacyLocalStorageKey &&
          options.legacyLocalStorageKey === name
        ) {
          value = readLegacyLocalStorage<T>(options.legacyLocalStorageKey);
          if (value !== null) {
            // 先写入 IndexedDB，成功后才删除 localStorage 旧数据，避免迁移途中丢数据
            await set(name, value);
            localStorage.removeItem(options.legacyLocalStorageKey);
          }
        }
        return value ?? null;
      } catch (error) {
        warnFailure("read", name, error);
        return null;
      }
    },
    setItem: async (name, value) => {
      try {
        await set(name, value);
      } catch (error) {
        warnFailure("persist", name, error);
      }
    },
    removeItem: async (name) => {
      try {
        await del(name);
      } catch (error) {
        warnFailure("remove", name, error);
      }
    },
  };
}

/** 只读不删，读取 localStorage 旧格式数据；由调用方在 IDB 写入成功后再删除 */
function readLegacyLocalStorage<T>(key: string): StorageValue<T> | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StorageValue<T>;
  } catch (error) {
    console.warn(
      `[idb-storage] Failed to parse legacy localStorage key "${key}".`,
      error
    );
    return undefined;
  }
}
