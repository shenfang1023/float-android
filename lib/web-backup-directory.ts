// 网页自动备份用的文件夹。
// FileSystemDirectoryHandle 不能放进 JSON / kv，只能进 IndexedDB。
// 第一次选择必须由用户点击触发；之后 queryPermission 已是 granted 时，定时备份可以直接写。

const DB_NAME = "ai-phone-web-backup";
const STORE = "handles";
const KEY = "dir";
const WRITE_MODE = "readwrite" as const;

// 本仓库的 TypeScript DOM 库没有带上 File System Access 的选择器和权限方法。
type DirectoryPermission = { mode: typeof WRITE_MODE };

export type WebBackupDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  queryPermission(descriptor?: DirectoryPermission): Promise<PermissionState>;
  requestPermission(descriptor?: DirectoryPermission): Promise<PermissionState>;
};

type DirectoryPicker = (options?: { id?: string; mode?: typeof WRITE_MODE }) => Promise<WebBackupDirectory>;

export type WebBackupAccess = "unsupported" | "missing" | "prompt" | "granted";

export type WebBackupStatus = {
  access: WebBackupAccess;
  directoryName: string | null;
};

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === "undefined") return null;
  const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === "function" ? picker.bind(window) : null;
}

export function webBackupDirectorySupported(): boolean {
  return directoryPicker() !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开备份文件夹数据库失败"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("读写备份文件夹失败"));
    });
  } finally {
    db.close();
  }
}

function asDirectoryHandle(value: unknown): WebBackupDirectory | null {
  if (!value || typeof value !== "object") return null;
  const handle = value as Partial<WebBackupDirectory>;
  if (typeof handle.getFileHandle !== "function" || typeof handle.queryPermission !== "function") return null;
  return value as WebBackupDirectory;
}

async function loadHandle(): Promise<WebBackupDirectory | null> {
  const stored = await withStore<unknown>("readonly", (store) => store.get(KEY));
  return asDirectoryHandle(stored);
}

async function saveHandle(handle: WebBackupDirectory): Promise<void> {
  await withStore("readwrite", (store) => store.put(handle, KEY));
}

function statusOf(access: WebBackupAccess, handle: WebBackupDirectory | null): WebBackupStatus {
  return { access, directoryName: handle?.name || null };
}

export async function readWebBackupStatus(): Promise<WebBackupStatus> {
  if (!webBackupDirectorySupported()) return statusOf("unsupported", null);
  try {
    const handle = await loadHandle();
    if (!handle) return statusOf("missing", null);
    const perm = await handle.queryPermission({ mode: WRITE_MODE });
    return statusOf(perm === "granted" ? "granted" : "prompt", handle);
  } catch {
    return statusOf("missing", null);
  }
}

/** 必须在用户点击里调用。用户取消选择时抛出 AbortError。 */
export async function pickWebBackupDirectory(): Promise<WebBackupStatus> {
  if (!webBackupDirectorySupported()) return statusOf("unsupported", null);
  const picker = directoryPicker();
  if (!picker) return statusOf("unsupported", null);
  const handle = await picker({
    id: "ai-phone-autobackup",
    mode: WRITE_MODE,
  });
  await saveHandle(handle);
  let perm: PermissionState = "prompt";
  try {
    perm = await handle.queryPermission({ mode: WRITE_MODE });
  } catch {
    perm = "prompt";
  }
  if (perm !== "granted") {
    try {
      perm = await handle.requestPermission({ mode: WRITE_MODE });
    } catch {
      perm = "prompt";
    }
  }
  return statusOf(perm === "granted" ? "granted" : "prompt", handle);
}

/** 定时任务里调用。权限还是 prompt / denied 时返回 null，不弹窗。 */
export async function openGrantedWebBackupDirectory(): Promise<WebBackupDirectory | null> {
  if (!webBackupDirectorySupported()) return null;
  try {
    const handle = await loadHandle();
    if (!handle) return null;
    const perm = await handle.queryPermission({ mode: WRITE_MODE });
    return perm === "granted" ? handle : null;
  } catch {
    return null;
  }
}
