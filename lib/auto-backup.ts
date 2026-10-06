// lib/auto-backup.ts
// 自动备份：每 6 小时写一份全量 zip，保留最近 3 份。
//
// 安装包写到系统「文档」目录（Android 需要「所有文件访问」；iOS 写到应用文档目录）。
// 网页写到用户选定的文件夹（File System Access）。没有这个能力的浏览器用手动导出。
//
// 空库不备份：库被清空时不能拿空快照把最后一份好备份轮换掉。

import { Capacitor } from "@capacitor/core";
import { hydrateKvDb, isKvHydrated, kvGet, kvSet } from "./kv-db";
import { loadCharacters } from "./character-storage";
import { hasPublicDocumentsAccess } from "./storage-access";
import { openGrantedWebBackupDirectory, type WebBackupDirectory } from "./web-backup-directory";

const PERMISSION_BLOCKED_KEY = "ai_phone_autobackup_perm_blocked";

const LAST_RUN_KEY = "ai_phone_autobackup_last_at";
export const AUTOBACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;
const RETAIN = 3;
const FILE_PREFIX = "ai-phone-autobackup-";

export function getLastAutoBackupAt(): string | null {
  return kvGet(LAST_RUN_KEY);
}

/** 自动备份曾因没有写入位置被跳过。 */
export function isAutoBackupPermissionBlocked(): boolean {
  return kvGet(PERMISSION_BLOCKED_KEY) === "1";
}

export function backupFileName(createdAt: string): string {
  return `${FILE_PREFIX}${createdAt.replace(/[:.]/g, "-").slice(0, 19)}.zip`;
}

/** 按文件名里的时间排序，返回需要删掉的最旧文件。其他文件名不动。 */
export function backupNamesToDelete(names: readonly string[], retain = RETAIN): string[] {
  const matched = names
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(".zip"))
    .sort();
  if (matched.length <= retain) return [];
  return matched.slice(0, matched.length - retain);
}

async function rotateOldBackups(): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  try {
    const res = await Filesystem.readdir({ path: "", directory: Directory.Documents });
    const names = res.files
      .map((file) => (typeof file === "string" ? file : file.name))
      .filter((name): name is string => typeof name === "string");
    for (const name of backupNamesToDelete(names)) {
      await Filesystem.deleteFile({ path: name, directory: Directory.Documents }).catch(() => {});
    }
  } catch {
    // 列目录失败不阻塞备份本身
  }
}

async function rotateWebBackups(dir: WebBackupDirectory): Promise<void> {
  const names: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") names.push(name);
  }
  for (const name of backupNamesToDelete(names)) {
    await dir.removeEntry(name).catch(() => {});
  }
}

async function writeWebBackupFile(dir: WebBackupDirectory, filename: string, blob: Blob): Promise<void> {
  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* 已经结束 */ }
    try { await dir.removeEntry(filename); } catch { /* 残件清不掉就留给下一轮 */ }
    throw error;
  }
}

async function createBackupIfWorthSaving(): Promise<{ blob: Blob; createdAt: string } | null> {
  if (loadCharacters().length === 0) return null;
  const { createBackupBlob } = await import("./data-management/backup");
  const { blob, manifest } = await createBackupBlob();
  if (manifest.totalRecords === 0) return null;
  return { blob, createdAt: manifest.createdAt };
}

async function runNativeAutoBackup(): Promise<void> {
  if (!(await hasPublicDocumentsAccess())) {
    kvSet(PERMISSION_BLOCKED_KEY, "1");
    return;
  }
  if (kvGet(PERMISSION_BLOCKED_KEY)) kvSet(PERMISSION_BLOCKED_KEY, "0");

  const packed = await createBackupIfWorthSaving();
  if (!packed) return;

  const { downloadFile } = await import("./download-utils");
  await downloadFile(packed.blob, backupFileName(packed.createdAt));
  kvSet(LAST_RUN_KEY, packed.createdAt);
  await rotateOldBackups();
}

async function runWebAutoBackup(): Promise<void> {
  const dir = await openGrantedWebBackupDirectory();
  if (!dir) {
    kvSet(PERMISSION_BLOCKED_KEY, "1");
    return;
  }
  if (kvGet(PERMISSION_BLOCKED_KEY)) kvSet(PERMISSION_BLOCKED_KEY, "0");

  const packed = await createBackupIfWorthSaving();
  if (!packed) return;

  await writeWebBackupFile(dir, backupFileName(packed.createdAt), packed.blob);
  kvSet(LAST_RUN_KEY, packed.createdAt);
  await rotateWebBackups(dir);
}

let _running = false;

export async function maybeRunAutoBackup(): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    await hydrateKvDb();
    if (!isKvHydrated()) return;

    const last = Date.parse(kvGet(LAST_RUN_KEY) ?? "") || 0;
    if (Date.now() - last < AUTOBACKUP_INTERVAL_MS) return;

    // 这里区分的是「安装包壳」和「浏览器网站」。
    // iOS 也是 native，备份走 Capacitor 文档目录，不走网页的文件夹选择。
    if (Capacitor.isNativePlatform()) await runNativeAutoBackup();
    else await runWebAutoBackup();
  } catch (err) {
    console.warn("[auto-backup] failed:", err);
  } finally {
    _running = false;
  }
}

let _started = false;

/** App 启动时调用一次。启动后 30s 首检，运行中每 30min 轮询。网页没有已授权文件夹时会跳过。 */
export function startAutoBackupLoop(): void {
  if (_started || typeof window === "undefined") return;
  _started = true;
  window.setTimeout(() => void maybeRunAutoBackup(), STARTUP_DELAY_MS);
  window.setInterval(() => void maybeRunAutoBackup(), TICK_MS);
}
