import { clockForCalendarOwner, loadCalendarWeekPlan } from "./calendar-storage";
import type { CalendarScheduleItem } from "./calendar-types";
import { sortScheduleItems, timeToMinutes } from "./calendar-utils";
import {
  getCharFindMyConfig,
  getHomePlace,
  loadMapPlaces,
  matchPlaceByName,
  type MapPlace,
} from "./findmy-storage";

// ── 角色实时位置推演 ─────────────────────────────────────
// 三级：手动钉死 → 当前日程地点（模糊匹配地点库）→ 家（boundCharacterId 绑定的地点）
// 全部同步读取（localStorage/kv），装配器和 UI 共用同一个真相源。

export type PresenceSource = "override" | "schedule" | "home";

export type CharacterPresence = {
  characterId: string;
  place: MapPlace;
  source: PresenceSource;
  /** 命中来源的日程条目（source==="schedule" 时有值） */
  scheduleItem?: Pick<CalendarScheduleItem, "startTime" | "endTime" | "location" | "title">;
  /** 手动钉死时的用户备注 */
  note?: string;
  /** 日程里有地点文本但地点库没匹配上——UI 提示"去钉一下" */
  unresolvedLocationText?: string;
};

/** 取角色当前时段的日程条目（与 getCurrentCalendarScheduleForPrompt 同口径，但返回原始 item） */
export function getCurrentScheduleItem(characterId: string, now = new Date()): CalendarScheduleItem | null {
  const clock = clockForCalendarOwner("character", characterId, now);
  const date = clock.dateIso;
  const weekStart = clock.weekStartIso;
  const currentMinute = clock.minutes;
  const plan = loadCalendarWeekPlan("character", characterId, weekStart);
  if (!plan) return null;
  return sortScheduleItems(plan.items).find(item => {
    if (item.date !== date) return false;
    const start = timeToMinutes(item.startTime);
    const end = timeToMinutes(item.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return start <= currentMinute && currentMinute < end;
  }) ?? null;
}

export function resolveCharacterPresence(characterId: string, now = new Date()): CharacterPresence | null {
  const cfg = getCharFindMyConfig(characterId);
  const places = loadMapPlaces();

  // 1) 手动钉死
  if (cfg?.overridePlaceId) {
    const place = places.find(p => p.id === cfg.overridePlaceId);
    if (place) return { characterId, place, source: "override", note: cfg.overrideNote };
    // 地点被删了——清掉失效 override 继续推演
  }

  // 2) 当前日程地点
  const item = getCurrentScheduleItem(characterId, now);
  if (item?.location?.trim()) {
    const place = matchPlaceByName(item.location, places);
    if (place) {
      return {
        characterId,
        place,
        source: "schedule",
        scheduleItem: { startTime: item.startTime, endTime: item.endTime, location: item.location, title: item.title },
      };
    }
    // 地点库没有这个地点——先落家，但把未解析文本带出去让 UI 提示
    const home = getHomePlace(characterId);
    if (home) {
      return { characterId, place: home, source: "home", unresolvedLocationText: item.location.trim() };
    }
    return null;
  }

  // 3) 家
  const home = getHomePlace(characterId);
  if (home) return { characterId, place: home, source: "home" };
  return null;
}

export function resolveAllPresences(characterIds: string[], now = new Date()): Map<string, CharacterPresence> {
  const out = new Map<string, CharacterPresence>();
  for (const id of characterIds) {
    const p = resolveCharacterPresence(id, now);
    if (p) out.set(id, p);
  }
  return out;
}

// ── 提示词文本 ──

/** 私聊尾部锚点："当前位置：健身房（15:00-16:00 私教课）" */
export function formatPresenceForPrompt(presence: CharacterPresence): string {
  const { place, source, scheduleItem, note } = presence;
  if (source === "schedule" && scheduleItem) {
    return `${place.emoji} ${place.name}（${scheduleItem.startTime}-${scheduleItem.endTime} ${scheduleItem.title}）`;
  }
  if (source === "override") {
    return `${place.emoji} ${place.name}${note?.trim() ? `（${note.trim()}）` : "（手动标记）"}`;
  }
  return `${place.emoji} ${place.name}`;
}
