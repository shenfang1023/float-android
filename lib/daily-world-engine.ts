// lib/daily-world-engine.ts
// 今日世界三段式生成：
//   Phase A 世界日纲——一次调用，花名册(简介+关系)→天气/氛围+互动骨架
//   Phase B 角色日行程——每角色一次调用（复用 calendar 全量组装），
//           带上分配给自己的互动，输出日程行 + 心情/想法/待办/和谁扩展段
//   Phase C 撮合校正——一次轻量调用，对齐各方版本里的同一场互动、落定时间/结果
//
// 落库：日程项进各角色 week plan（替换当日 generated 条目，manual 不动）；
//       日纲进 daily-world-storage，供 chat/朋友圈/群聊 marker 传播。

import type { CalendarScheduleItem, DailyWorldInteraction, DailyWorldPlan } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { resolveCalendarAssemblerInput } from "./calendar-engine";
import { sendLLMRequest } from "./chat-engine";
import {
    loadCalendarWeekPlan,
    replaceCalendarWeekItems,
    normalizeGeneratedScheduleItems,
} from "./calendar-storage";
import { getWeekdayLabel, sortScheduleItems } from "./calendar-utils";
import {
    formatScheduleClockRule,
    getSystemTimeZone,
    getZonedClock,
    normalizeTimeZone,
    weekStartFromIsoDate,
} from "./character-time";
import { partitionByTier } from "./character-tier";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { loadDailyWorldPlan, saveDailyWorldPlan } from "./daily-world-storage";
import type { LLMMessage } from "./llm-prompt-assembler";

const MAX_INTERACTIONS = 6;
const MAX_DAY_ITEMS = 6;

// ── Phase A ──────────────────────────────────────────────

function buildOutlinePrompt(date: string, roster: { name: string; brief: string; relations: string; clock: string }[]): string {
    const rosterText = roster.map((r, i) =>
        `[${i + 1}] ${r.name}\n简介：${r.brief || "（无）"}${r.relations ? `\n关系：${r.relations}` : ""}\n时区：${r.clock}`
    ).join("\n\n");
    return `你在为一部群像生活剧设计「今日世界」：${date}。

角色花名册：
${rosterText}

根据他们的身份、彼此关系（同校/同事/打过比赛/暧昧等），推演这一天世界里自然会发生什么。
只安排符合关系线的互动——不熟的人不会突然约饭，有过节的可以偶遇起冲突。
每个角色后面单独排课的 HH:MM 用花名册里的时区。设了时区的角色按那个时区的钟点排，按手机或北京时间排课是错的。
跨时区的共同 EVENT 只写清晨、上午、傍晚、夜里，不写一个所有人共用的 HH:MM。

严格按以下格式输出（不要输出任何其他内容）：

WEATHER|<一句话天气>
VIBE|<一句话当日整体氛围/背景>
EVENT|<时段如"傍晚"或同一时区内的"15:00-16:00">|<地点>|<参与者名字,逗号分隔>|<一件事描述>
（EVENT 最多 ${MAX_INTERACTIONS} 条；可以少于这个数，没有合适互动就只出 0-1 条；每条必须是≥2人真正同场的事，不是各自单独的日程）`;
}

type OutlineEvent = { timeHint: string; place: string; participantNames: string[]; what: string };

function parseOutlineOutput(raw: string, nameToId: Map<string, string>): {
    weather: string;
    vibe: string;
    interactions: DailyWorldInteraction[];
} {
    let weather = "";
    let vibe = "";
    const interactions: DailyWorldInteraction[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*]\s*/, "");
        const w = /^WEATHER\s*[|｜:：]\s*(.+)$/.exec(t);
        if (w) { weather = w[1].trim(); continue; }
        const v = /^VIBE\s*[|｜:：]\s*(.+)$/.exec(t);
        if (v) { vibe = v[1].trim(); continue; }
        if (/^EVENT\s*[|｜]/i.test(t)) {
            const parts = t.split(/[|｜]/).map(s => s.trim());
            if (parts.length < 5) continue;
            const participantIds = parts[3]
                .split(/[,，、]/)
                .map(n => nameToId.get(n.trim()))
                .filter((id): id is string => Boolean(id));
            if (participantIds.length < 2) continue; // 不是真多人同场的不算互动
            interactions.push({
                id: `dw_evt_${Date.now()}_${interactions.length}_${Math.random().toString(36).slice(2, 5)}`,
                participantIds,
                timeHint: parts[1],
                place: parts[2] === "无" ? "" : parts[2],
                what: parts.slice(4).join("|"),
            });
        }
    }
    return { weather, vibe, interactions: interactions.slice(0, MAX_INTERACTIONS) };
}

// ── Phase B ──────────────────────────────────────────────

type DayExtras = {
    mood?: string;
    note?: string;
    todos?: { text: string; done: boolean }[];
    participantNames?: string[];
    busyLevel?: number;
};

function buildDayInstruction(
    charName: string,
    date: string,
    weekday: string,
    assigned: DailyWorldInteraction[],
    nameOf: (id: string) => string,
    timeZone?: string | null,
): string {
    const assignedText = assigned.length
        ? assigned.map((it, i) =>
            `互动${i + 1}：${it.timeHint} @${it.place || "未定"} 与${it.participantIds.filter(id => id !== "__user__" && nameOf(id) !== charName).map(nameOf).join("、")} —— ${it.what}`
        ).join("\n")
        : "";
    return [
        `请为${charName}生成 ${date}（${weekday}）这一天的日程安排。`,
        assignedText ? `\n今天世界里已确定的互动（必须纳入你的日程，时间和描述要与之一致）：\n${assignedText}` : "",
        "",
        `严格按以下格式输出，每行一条，最多 ${MAX_DAY_ITEMS} 条，宁缺毋滥：`,
        `SCHEDULE|${date}|开始HH:MM|结束HH:MM|地点|emoji|事项`,
        "可选的扩展行（锚定到对应 SCHEDULE 的开始时间）：",
        "WITH|<开始时间>|<同场者名字,逗号分隔>",
        "BUSY|<开始时间>|<0空闲/1轻度/2忙碌/3深度专注>",
        "MOOD|<开始时间>|<做这件事时的心情一句话>",
        "NOTE|<开始时间>|<内心想法一句话>",
        "TODO|<开始时间>|<待办1;待办2;待办3>",
        "",
        "要求：符合本周已有日程的节奏与职业作息；扩展行只给真正值得记的事项。",
        "事项写法：每条≤30字，用客观简洁的记录风格写行为事实，像日志而不是散文——",
        "正确示例：「在便利店买了三明治当午饭」「陪她试婚纱，提了两句意见」；",
        "错误示例：「阳光透过百叶窗在地板上投下斑驳的光影，他陷入了沉思」（不要这种文艺渲染）。",
        formatScheduleClockRule(timeZone),
        `输出的日期必须是 ${date}。时间基准里的当地现在只用来对齐作息，不要改日期。`,
    ].join("\n");
}

type ParsedDay = { items: CalendarScheduleItem[]; extras: Map<string, DayExtras> };

function parseDayOutput(raw: string, date: string, weekStart: string): ParsedDay {
    const extras = new Map<string, DayExtras>();
    const scheduleLines: string[] = [];
    const ex = (time: string) => {
        const key = time.trim();
        const cur = extras.get(key) ?? {};
        extras.set(key, cur);
        return cur;
    };
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*]\s*/, "").replace(/^\d+[.)、]\s*/, "");
        if (!t) continue;
        const parts = t.split(/[|｜]/).map(s => s.trim());
        if (/^SCHEDULE$/i.test(parts[0])) {
            // SCHEDULE|date|start|end|place|emoji|title —— 转成周程解析器的行格式
            scheduleLines.push(`${parts[1]}|${getWeekdayLabel(parts[1] ?? date)}|${parts[2]}|${parts[3]}|${parts[4]}|${parts[5]}|${parts.slice(6).join("|")}`);
            continue;
        }
        const tag = parts[0]?.toUpperCase();
        const time = parts[1] ?? "";
        if (tag === "WITH") ex(time).participantNames = (parts[2] ?? "").split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        else if (tag === "BUSY") ex(time).busyLevel = Math.min(3, Math.max(0, parseInt(parts[2] ?? "0", 10) || 0));
        else if (tag === "MOOD") ex(time).mood = parts.slice(2).join("|").trim() || undefined;
        else if (tag === "NOTE") ex(time).note = parts.slice(2).join("|").trim() || undefined;
        else if (tag === "TODO") {
            const texts = (parts[2] ?? "").split(/[;；]/).map(s => s.trim()).filter(Boolean);
            if (texts.length) ex(time).todos = texts.map(text => ({ text, done: false }));
        }
    }
    // 复用周程解析（weekDates 已含当日）再过滤到目标日期
    const normalized = normalizeGeneratedScheduleItems(
        scheduleLines
            .map(line => line.split("|").map(s => s.trim()))
            .filter(p => p[0] === date && p.length >= 7)
            .map(p => ({ date: p[0], startTime: p[2], endTime: p[3], location: p[4] === "无" ? "" : p[4], emoji: p[5], title: p.slice(6).join("|") })),
    );
    return { items: normalized.filter(i => i.date === date), extras };
}

// ── Phase B·配角批量简版 ──────────────────────────────────
// 配角是背景板：不逐个走完整组装，一次调用给全部配角出简版日程（每人 0~3 条），
// 成本 ≈ 主角一个人的一次调用。配角仍可在大纲/撮合里参与互动、被主角日程提及。

const MAX_NPC_DAY_ITEMS = 3;

function buildNpcBatchInstruction(
    date: string,
    weekday: string,
    npcs: { name: string; brief: string; assigned: string[]; timeZone?: string | null }[],
): string {
    const roster = npcs.map((n, i) => {
        const assigned = n.assigned.length ? `\n  今日已确定参与的互动：${n.assigned.join("；")}` : "";
        return `[${i + 1}] ${n.name}（${n.brief || "配角"}）${assigned}\n  ${formatScheduleClockRule(n.timeZone)}`;
    }).join("\n");
    return `请为以下配角批量生成 ${date}（${weekday}）的日程——他们是背景人物，日程只用来给世界一点生活质感，不需要细致：

${roster}

严格按以下格式输出，每个配角 0~${MAX_NPC_DAY_ITEMS} 条，没合适的就不输出该角色：
NPCDAY|<角色名字>|<开始HH:MM>|<结束HH:MM>|<地点>|<事项>
要求：事项≤16字，客观简洁；已分配互动的配角必须包含对应时段的条目；其余日常符合人物身份即可。
HH:MM 按该角色自己的时间基准书写。输出日期对应的是 ${date}，不要改成别的日子。`;
}

function parseNpcBatchOutput(
    raw: string,
    date: string,
    nameToId: Map<string, string>,
): Map<string, CalendarScheduleItem[]> {
    const perChar = new Map<string, { startTime: string; endTime: string; location: string; title: string }[]>();
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*]\s*/, "");
        const parts = t.split(/[|｜]/).map(s => s.trim());
        if (!/^NPCDAY$/i.test(parts[0]) || parts.length < 6) continue;
        const charId = nameToId.get(parts[1]);
        if (!charId) continue;
        const list = perChar.get(charId) ?? [];
        if (list.length >= MAX_NPC_DAY_ITEMS) continue;
        list.push({
            startTime: parts[2],
            endTime: parts[3],
            location: parts[4] === "无" ? "" : parts[4],
            title: parts.slice(5).join("|"),
        });
        perChar.set(charId, list);
    }
    const result = new Map<string, CalendarScheduleItem[]>();
    for (const [charId, list] of perChar) {
        result.set(charId, normalizeGeneratedScheduleItems(
            list.map(i => ({ date, ...i })),
        ).filter(i => i.date === date));
    }
    return result;
}

// ── Phase C ──────────────────────────────────────────────

function buildReconcilePrompt(
    date: string,
    outline: DailyWorldInteraction[],
    perCharMentions: { name: string; mentions: { time: string; partners: string[]; what: string }[] }[],
    nameOf: (id: string) => string,
): string {
    const outlineText = outline.map((it, i) =>
        `大纲${i + 1}：${it.timeHint} @${it.place || "未定"} ${it.participantIds.map(nameOf).join("、")} —— ${it.what}`
    ).join("\n") || "（无大纲互动）";
    const mentionText = perCharMentions.flatMap(c =>
        c.mentions.map(m => `${c.name}版本：${m.time} 与${m.partners.join("、")} —— ${m.what}`)
    ).join("\n") || "（各角色日程里未提及互动）";
    return `请把 ${date} 这一天的多人互动对齐成一致的世界事实。

大纲互动：
${outlineText}

各角色日程里实际写到的同场互动：
${mentionText}

严格按格式输出（不要输出其他内容），每行一条最终确认的互动：
FINAL|<大纲编号或NEW>|<开始HH:MM>|<结束HH:MM>|<地点>|<参与者名字,逗号分隔>|<发生的事>|<结果/氛围一句话>
（同一互动若两个角色版本时间漂移，取交集合理值；角色自发产生的大纲外互动标 NEW 也可收录；最多 ${MAX_INTERACTIONS} 条）
开始和结束用参与者共同的本地钟点。参与者时区不同时，开始和结束两段留空，时段写进事件描述。`;
}

function parseReconcileOutput(
    raw: string,
    outline: DailyWorldInteraction[],
    nameToId: Map<string, string>,
): DailyWorldInteraction[] {
    const finals: DailyWorldInteraction[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*]\s*/, "");
        if (!/^FINAL\s*[|｜]/i.test(t)) continue;
        const parts = t.split(/[|｜]/).map(s => s.trim());
        if (parts.length < 8) continue;
        const outlineIdx = /^NEW$/i.test(parts[1]) ? -1 : Math.max(0, (parseInt(parts[1], 10) || 1) - 1);
        const base = outlineIdx >= 0 ? outline[outlineIdx] : undefined;
        const participantIds = parts[5]
            .split(/[,，、]/)
            .map(n => nameToId.get(n.trim()))
            .filter((id): id is string => Boolean(id));
        if (participantIds.length < 2) continue;
        const startTime = /^\d{1,2}:\d{2}$/.test(parts[2]) ? parts[2] : undefined;
        const endTime = /^\d{1,2}:\d{2}$/.test(parts[3]) ? parts[3] : undefined;
        finals.push({
            id: base?.id ?? `dw_evt_${Date.now()}_${finals.length}_${Math.random().toString(36).slice(2, 5)}`,
            participantIds,
            timeHint: base?.timeHint ?? (startTime && endTime ? `${startTime}-${endTime}` : "同时段"),
            startTime,
            endTime,
            place: parts[4] === "无" ? "" : parts[4],
            what: parts[6],
            outcome: parts.slice(7).join("|") || undefined,
        });
    }
    return finals.slice(0, MAX_INTERACTIONS);
}

// ── 主入口 ────────────────────────────────────────────────

export type GenerateDailyWorldResult = {
    success: boolean;
    error?: string;
    plan?: DailyWorldPlan;
    perCharacterItems?: Record<string, number>;
};

export async function generateDailyWorld(
    date: string,
    characterIds: string[],
    options?: { onProgress?: (stage: "outline" | "detail" | "reconcile", detail?: string) => void },
): Promise<GenerateDailyWorldResult> {
    const chars = loadCharacters().filter(c => characterIds.includes(c.id));
    if (chars.length === 0) return { success: false, error: "未选择参与角色" };

    const nameToId = new Map<string, string>(chars.map(c => [c.name.trim(), c.id]));
    const nameOf = (id: string) =>
        id === "__user__" ? "用户" : (chars.find(c => c.id === id)?.name ?? id);
    const zoneOf = (id: string) => {
        if (id === "__user__") return getSystemTimeZone();
        return normalizeTimeZone(chars.find(c => c.id === id)?.timeZone) || getSystemTimeZone();
    };
    const softenCrossZoneHint = (hint: string, participantIds: string[]) => {
        const zones = new Set(participantIds.map(zoneOf));
        if (zones.size <= 1 || !/\d{1,2}:\d{2}/.test(hint)) return hint;
        const stripped = hint.replace(/\d{1,2}:\d{2}(?:\s*[-~～到至]\s*\d{1,2}:\d{2})?/g, "").replace(/\s+/g, " ").trim();
        return stripped || "各自本地同一时段";
    };

    // API 解析：用第一个角色的主对话绑定跑大纲/撮合（保持一致风格）
    const bindings = loadBindingConfig();
    const outlineApiId = resolveBinding(bindings, chars[0].id, "chat").apiConfigId
        || resolveBinding(bindings, chars[0].id, "calendar").apiConfigId;
    const outlineApi = outlineApiId ? loadApiConfigs().find(c => c.id === outlineApiId) : undefined;
    if (!outlineApi) return { success: false, error: "未绑定 API，请先给角色配置对话或日历 API。" };

    // ── Phase A ──
    options?.onProgress?.("outline", "推演今日世界…");
    const roster = chars.map(c => {
        const clock = getZonedClock(c.timeZone);
        const named = normalizeTimeZone(c.timeZone);
        return {
            name: c.name,
            brief: c.briefPersona?.trim() || c.persona?.slice(0, 160) || "",
            relations: formatCharacterRelationsForPrompt(c.id).trim(),
            clock: named
                ? `${named}，当地现在 ${clock.dateIso} ${clock.label}`
                : `手机时区 ${clock.timeZone}，当地现在 ${clock.dateIso} ${clock.label}`,
        };
    });
    const outlineRes = await simpleLLMCall(
        outlineApi,
        [{ role: "user", content: buildOutlinePrompt(date, roster) }],
        { temperature: 0.7 },
    );
    if (!outlineRes.content) return { success: false, error: outlineRes.error || "世界日纲生成失败" };
    const outline = parseOutlineOutput(outlineRes.content, nameToId);
    for (const interaction of outline.interactions) {
        interaction.timeHint = softenCrossZoneHint(interaction.timeHint, interaction.participantIds);
    }

    // ── Phase B ──
    // 主角逐个完整生成；配角（NPC）全部并进一次批量简版调用
    const { mains, npcs } = partitionByTier(chars);
    const weekStart = weekStartFromIsoDate(date);
    const perCharMentions: { name: string; mentions: { time: string; partners: string[]; what: string }[] }[] = [];
    const perCharacterItems: Record<string, number> = {};

    for (const [idx, char] of mains.entries()) {
        options?.onProgress?.("detail", `生成${char.name}的日程… (${idx + 1}/${mains.length})`);
        const assigned = outline.interactions.filter(i => i.participantIds.includes(char.id));
        try {
            const resolved = await resolveCalendarAssemblerInput("character", char.id, weekStart);
            const instruction = buildDayInstruction(char.name, date, getWeekdayLabel(date), assigned, nameOf, char.timeZone);
            const messages: LLMMessage[] = [
                ...resolved.llmMessages,
                { role: "user", content: instruction, _debugMeta: { marker: "daily_world_day" } },
            ];
            const raw = await sendLLMRequest(
                resolved.apiConfig, resolved.preset, messages, resolved.regexes,
                { characterName: `今日世界:${char.name}` },
                { appId: "calendar", appTags: ["calendar", "daily_world"] },
            );
            const parsed = parseDayOutput(raw, date, weekStart);

            // 替换当日 generated 条目（manual 保留）
            const plan = loadCalendarWeekPlan("character", char.id, weekStart);
            const kept = (plan?.items ?? []).filter(i => !(i.date === date && i.source !== "manual"));
            const dayItems = parsed.items.map(item => {
                const e = parsed.extras.get(item.startTime);
                return {
                    ...item,
                    mood: e?.mood,
                    note: e?.note,
                    todos: e?.todos,
                    busyLevel: e?.busyLevel,
                    participants: e?.participantNames
                        ?.map(n => nameToId.get(n))
                        .filter((id): id is string => Boolean(id)),
                };
            });
            replaceCalendarWeekItems("character", char.id, weekStart, sortScheduleItems([...kept, ...dayItems]));
            perCharacterItems[char.id] = dayItems.length;

            // 收集该角色提到的互动供撮合
            const mentions = dayItems
                .filter(i => (i.participants?.length ?? 0) > 0)
                .map(i => ({
                    time: `${i.startTime}-${i.endTime}`,
                    partners: (i.participants ?? []).map(nameOf),
                    what: i.title,
                }));
            if (mentions.length) perCharMentions.push({ name: char.name, mentions });
        } catch (error) {
            console.warn(`[DailyWorld] ${char.name} day generation failed:`, error);
            perCharacterItems[char.id] = 0;
        }
    }

    // ── Phase B·配角批量 ──
    if (npcs.length) {
        options?.onProgress?.("detail", `批量生成 ${npcs.length} 位配角的简版日程…`);
        try {
            const npcInputs = npcs.map(c => ({
                name: c.name,
                brief: (c.briefPersona?.trim() || c.persona?.slice(0, 80) || "").slice(0, 80),
                timeZone: c.timeZone,
                assigned: outline.interactions
                    .filter(i => i.participantIds.includes(c.id))
                    .map(i => `${i.timeHint} @${i.place || "未定"} 与${i.participantIds.filter(p => p !== c.id).map(nameOf).join("、")}——${i.what}`),
            }));
            const npcRes = await simpleLLMCall(
                outlineApi,
                [{ role: "user", content: buildNpcBatchInstruction(date, getWeekdayLabel(date), npcInputs) }],
                { temperature: 0.6 },
            );
            const npcItems = npcRes.content ? parseNpcBatchOutput(npcRes.content, date, nameToId) : new Map<string, CalendarScheduleItem[]>();
            for (const npc of npcs) {
                const dayItems = npcItems.get(npc.id) ?? [];
                const plan = loadCalendarWeekPlan("character", npc.id, weekStart);
                const kept = (plan?.items ?? []).filter(i => !(i.date === date && i.source !== "manual"));
                replaceCalendarWeekItems("character", npc.id, weekStart, sortScheduleItems([...kept, ...dayItems]));
                perCharacterItems[npc.id] = dayItems.length;
            }
        } catch (error) {
            console.warn("[DailyWorld] NPC batch generation failed:", error);
            for (const npc of npcs) perCharacterItems[npc.id] = perCharacterItems[npc.id] ?? 0;
        }
    }

    // ── Phase C ──
    options?.onProgress?.("reconcile", "对齐互动事实…");
    let finalInteractions = outline.interactions;
    if (outline.interactions.length || perCharMentions.length) {
        const recRes = await simpleLLMCall(
            outlineApi,
            [{ role: "user", content: buildReconcilePrompt(date, outline.interactions, perCharMentions, nameOf) }],
            { temperature: 0.3 },
        );
        if (recRes.content) {
            const finals = parseReconcileOutput(recRes.content, outline.interactions, nameToId);
            if (finals.length) finalInteractions = finals;
        }
    }
    for (const interaction of finalInteractions) {
        const zones = new Set(interaction.participantIds.map(zoneOf));
        if (zones.size <= 1) continue;
        interaction.startTime = undefined;
        interaction.endTime = undefined;
        interaction.timeHint = softenCrossZoneHint(interaction.timeHint, interaction.participantIds);
    }

    // 撮合结果回写：给命中的日程项 stamp dayEventId + participants
    for (const char of chars) {
        const plan = loadCalendarWeekPlan("character", char.id, weekStart);
        if (!plan) continue;
        let dirty = false;
        const items = plan.items.map(item => {
            if (item.date !== date) return item;
            const hit = finalInteractions.find(ev =>
                ev.participantIds.includes(char.id) &&
                ev.startTime && Math.abs(minutes(ev.startTime) - minutes(item.startTime)) <= 30);
            if (!hit) return item;
            dirty = true;
            return {
                ...item,
                dayEventId: hit.id,
                participants: Array.from(new Set([...(item.participants ?? []), ...hit.participantIds.filter(p => p !== char.id)])),
            };
        });
        if (dirty) replaceCalendarWeekItems("character", char.id, weekStart, items);
    }

    const worldPlan: DailyWorldPlan = {
        id: `dw_${date}_${Math.random().toString(36).slice(2, 6)}`,
        date,
        weather: outline.weather,
        vibe: outline.vibe,
        interactions: finalInteractions,
        characterIds: chars.map(c => c.id),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveDailyWorldPlan(worldPlan);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("calendar-updated"));
    }
    return { success: true, plan: worldPlan, perCharacterItems };
}

function minutes(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

export { loadDailyWorldPlan };
