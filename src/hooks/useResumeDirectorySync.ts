import { useEffect } from "react";
import { useResumeStore, whenResumeStoreHydrated } from "@/store/useResumeStore";
import { syncResumesFromDirectory } from "@/utils/resumeFileSync";

let hasSyncedFromDirectory = false;
let activeSyncPromise: Promise<void> | null = null;

export const useResumeDirectorySync = () => {
  const updateResumeFromFile = useResumeStore(
    (state) => state.updateResumeFromFile
  );

  useEffect(() => {
    if (hasSyncedFromDirectory || activeSyncPromise) {
      return;
    }

    // 必须先等 IndexedDB 水合完成，否则 resumes 还是初始值，
    // 磁盘旧文件可能被误判为“更新”而覆盖内存中的新简历
    activeSyncPromise = whenResumeStoreHydrated()
      .then(() => syncResumesFromDirectory(updateResumeFromFile))
      .then(() => undefined)
      .catch((error) => {
        console.error("Error syncing resume directory:", error);
      })
      .finally(() => {
        hasSyncedFromDirectory = true;
        activeSyncPromise = null;
      });
  }, [updateResumeFromFile]);
};
