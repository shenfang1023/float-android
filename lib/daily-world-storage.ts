// lib/daily-world-storage.ts
// 世界日纲持久层：按日期键存一份"当天这群人发生了什么"的全局记录。
// 传播第一步的读取点——chat/朋友圈/群聊的 prompt 组装都从
// buildDailyWorldMarker 取当天与该角色相关的互动上下文。

import type { DailyWorldInteraction, DailyWorldPlan } from "./calendar-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_daily_world_v1";
const MAX_PLAN_DAYS = 14; // 只留近两周，老日纲自动淘汰
registerKvMigration(STORAGE_KEY);

type DailyWorldStore = Record<string, DailyWorldPlan>; // key = YYYY-MM-DD

function loadStore(): DailyWorldStore {
    try {
        const raw = kvGet(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
        return {};
    }
}

function saveStore(store: DailyWorldStore): void {
    // 淘汰过期日期
    const keys = Object.keys(store).sort();
    while (keys.length > MAX_PLAN_DAYS) {
        const oldest = keys.shift();
        if (oldest) delete store[oldest];
    }
    kvSet(STORAGE_KEY, JSON.stringify(store));
}

export function loadDailyWorldPlan(date: string): DailyWorldPlan | null {
    return loadStore()[date] ?? null;
}

export function saveDailyWorldPlan(plan: DailyWorldPlan): void {
    const store = loadStore();
    store[plan.date] = { ...plan, updatedAt: new Date().toISOString() };
    saveStore(store);
}

export function upsertDailyWorldInteraction(date: string, interaction: DailyWorldInteraction): void {
    const plan = loadDailyWorldPlan(date);
    if (!plan) return;
    plan.interactions = plan.interactions.filter(i => i.id !== interaction.id);
    plan.interactions.push(interaction);
    saveDailyWorldPlan(plan);
}

export function listRecentWorldPlans(days = 7): DailyWorldPlan[] {
    const store = loadStore();
    return Object.values(store)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, days);
}

/** 明细页一次性取全部（上限 MAX_PLAN_DAYS，天然有界） */
export function loadAllDailyWorldPlans(): DailyWorldPlan[] {
    return Object.values(loadStore());
}

/** 某角色某天参与的互动（含用户在场的事件） */
export function interactionsForCharacter(date: string, characterId: string): DailyWorldInteraction[] {
    const plan = loadDailyWorldPlan(date);
    if (!plan) return [];
    return plan.interactions.filter(i => i.participantIds.includes(characterId));
}

/**
 * 传播第一步：当日世界上下文 marker 文本。
 * 注入所有角色的 prompt——"今天你所在的世界里发生了这些事"。
 * 只列与 characterId 相关的互动 + 公共氛围；无日纲返回空串。
 */
export function buildDailyWorldMarker(
    characterId: string,
    date: string,
    resolveName?: (participantId: string) => string,
): string {
    const plan = loadDailyWorldPlan(date);
    if (!plan) return "";
    const nameOf = (id: string) => id === "__user__" ? "用户" : (resolveName?.(id) ?? id);

    const lines: string[] = [`【今日世界 ${date}】`];
    if (plan.weather) lines.push(`天气：${plan.weather}`);
    if (plan.vibe) lines.push(`氛围：${plan.vibe}`);

    const mine = interactionsForCharacter(date, characterId);
    const others = plan.interactions.filter(i => !i.participantIds.includes(characterId));

    for (const it of mine) {
        const partners = it.participantIds.filter(id => id !== characterId).map(nameOf);
        const timeRange = it.startTime && it.endTime ? `${it.startTime}-${it.endTime}` : it.timeHint;
        const withWhom = partners.length ? `，与${partners.join("、")}` : "";
        lines.push(`你的互动：${timeRange} @${it.place || "未定"} ${it.what}${withWhom}${it.outcome ? `（结果：${it.outcome}）` : ""}`);
    }
    // 他人的大事件也可被听见/谈起（圈子感），但只给摘要一行
    for (const it of others.slice(0, 3)) {
        const timeRange = it.startTime && it.endTime ? `${it.startTime}-${it.endTime}` : it.timeHint;
        const who = it.participantIds.map(nameOf).join("、");
        lines.push(`他人动态（你可能听说）：${timeRange} ${who}——${it.what}${it.outcome ? `（${it.outcome}）` : ""}`);
    }
    // 只有真有内容（天气/氛围/互动）时才注入，并附上"这是背景不是话题"的用法说明：
    // 今日世界当天字节不变，模型很容易把"你可能听说"的他人动态当成每日播报素材。
    const hasContent = lines.length > 1;
    if (hasContent) {
        lines.push("（今日世界是当天生活背景：只在与本轮对话相关时提起，已经讲过的互动不要再讲一遍。）");
    }
    return hasContent ? lines.join("\n") : "";
}
