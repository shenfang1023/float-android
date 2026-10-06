import type { Character } from "./character-types";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import type { CalendarOwnerType, CalendarScheduleItem } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import { formatScheduleClockRule } from "./character-time";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest, type ChatEngineError } from "./chat-engine";
import { applyGeneratedItemsMerge, buildCalendarScheduleMarker, clearGeneratedWeekItems, cloneWeekPlanWithManualEdits, loadCalendarWeekPlan, normalizeGeneratedScheduleItems, restoreCalendarWeekItems } from "./calendar-storage";
import {
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  sanitizeScheduleEmoji,
} from "./calendar-utils";

type CalendarAssemblerResolved = {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  llmMessages: LLMMessage[];
  ownerName: string;
};

function buildSyntheticUserCharacter(identity: UserIdentity | null): Character {
  const now = new Date().toISOString();
  const personaLines = [
    identity?.bio?.trim(),
    identity?.occupation ? `职业：${identity.occupation}` : "",
    identity?.age ? `年龄：${identity.age}` : "",
    identity?.gender && identity.gender !== "保密" ? `性别：${identity.gender}` : "",
    identity?.customSettings?.trim(),
  ].filter(Boolean);

  return {
    id: "__calendar_user__",
    name: identity?.name?.trim() || "用户",
    avatar: identity?.avatarUrl || null,
    persona: personaLines.join("\n") || "这是用户本人。",
    wechatID: "",
    createdAt: now,
    updatedAt: now,
  };
}

function clockRuleForCharacter(ownerId: string): string {
  return formatScheduleClockRule(loadCharacters().find(character => character.id === ownerId)?.timeZone);
}

function buildCalendarTriggerInstruction(ownerName: string, weekDates: string[], clockRule: string): string {
  return [
    `请为${ownerName}生成 ${weekDates[0]} 到 ${weekDates[6]} 这一周的日程安排。`,
    "请参考已有日程，生成这一周的完整日程安排。",
    "每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。emoji 段填一个最贴合该事项的表情符号。",
    "事项用客观简洁的记录风格写行为事实（≤30字，像日志不像散文）。正确示例：「在便利店买了三明治当午饭」；错误示例：「阳光洒进房间，他陷入了长久的沉思」。",
    "作息时间不受限制（早起、夜跑、通宵都可以安排），但每一天最多 5 条日程，宁缺毋滥。",
    clockRule,
    "日期用这一周里给出的公历日期。HH:MM 按时间基准的时区书写。",
  ].join("\n");
}

/** 单日重排（重roll）指令：把当天现有安排摆给模型看，反馈驱动修改 */
function buildDayTriggerInstruction(
  ownerName: string,
  date: string,
  dayItems: CalendarScheduleItem[],
  clockRule: string,
  feedback?: string,
): string {
  const existing = dayItems.length > 0
    ? `当天现有安排：\n${dayItems.map(i => `  ${i.startTime}-${i.endTime} @${i.location || "未定"} ${i.title}`).join("\n")}`
    : "当天目前没有任何安排。";
  return [
    `请为${ownerName}生成 ${date}（${getWeekdayLabel(date)}）这一天的日程安排。`,
    existing,
    feedback?.trim()
      ? `用户的调整要求：「${feedback.trim()}」。请按用户要求修改当天安排——合适的原有安排可以保留，不合适的删掉或改掉，需要时补充新的。`
      : "用户要求换一版安排：保持人设合理性，给出与现有安排不同的新日程（不想完全推翻也行，但要有明显变化）。",
    `每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。日期必须且只能是 ${date}。`,
    "事项用客观简洁的记录风格写行为事实（≤30字，像日志不像散文）。",
    "每一天最多 5 条日程，宁缺毋滥。",
    `要清空当天所有安排，改为输出一行：${date}|CLEAR`,
    clockRule,
    `时间基准里的当地现在只用来对齐作息。输出日期必须是 ${date}。`,
  ].join("\n");
}

/** 整周带反馈调整指令：不预清旧日程（模型要知道改了什么），只输出受影响日期 */
function buildWeekAdjustInstruction(ownerName: string, weekDates: string[], feedback: string, clockRule: string): string {
  return [
    `请按用户反馈调整${ownerName} ${weekDates[0]} 到 ${weekDates[6]} 这一周的日程。`,
    `用户反馈：「${feedback.trim()}」`,
    "只需要输出受影响/有变化的日期行；没提到的日期会保持原样，不要重复输出。",
    "涉及调整的日期请输出该日的完整日程（保留+修改+新增的都算）。",
    "每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。",
    "事项用客观简洁的记录风格写行为事实（≤30字，像日志不像散文）。每一天最多 5 条，宁缺毋滥。",
    "要清空某天的全部 AI 安排，输出一行：YYYY-MM-DD|CLEAR",
    clockRule,
    "日期仍用这一周的公历日期。HH:MM 按时间基准的时区书写。",
  ].join("\n");
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
}

function parseScheduleLines(rawText: string, weekStart: string): { items: CalendarScheduleItem[]; clearedDates: Set<string> } {
  const weekDates = new Set(getWeekDates(weekStart));
  const clearedDates = new Set<string>();
  const lines = stripCodeFences(rawText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const parsed: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    emoji?: string;
  }> = [];

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map(part => part.trim());

    // `日期|CLEAR` 哨兵：清空该日全部 AI 安排（带反馈重排时模型表达"删掉这天"的方式）
    if (parts.length >= 2 && /^clear$/i.test(parts[1]) && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
      if (weekDates.has(parts[0])) clearedDates.add(parts[0]);
      continue;
    }
    if (parts.length < 6) continue;

    const date = parts[0];
    const startTime = normalizeTime(parts[2]);
    const endTime = normalizeTime(parts[3]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekDates.has(date)) continue;
    if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) continue;

    const location = parts[4] === "无" ? "" : parts[4];
    // 新格式第 6 段为 emoji（YYYY-MM-DD|周几|开始|结束|地点|emoji|事项）；
    // 兼容旧格式（第 6 段直接是事项）：仅当该段确实是 emoji 时才按新格式取。
    let emoji = "";
    let title: string;
    if (parts.length >= 7) {
      const candidate = sanitizeScheduleEmoji(parts[5]);
      if (candidate && Array.from(parts[5]).length <= 3) {
        emoji = candidate;
        title = parts.slice(6).join("|");
      } else {
        title = parts.slice(5).join("|");
      }
    } else {
      title = parts[5];
    }
    if (!title.trim()) continue;

    parsed.push({
      date,
      startTime,
      endTime,
      location,
      title,
      emoji,
    });
  }

  return { items: normalizeGeneratedScheduleItems(parsed), clearedDates };
}

export async function resolveCalendarAssemblerInput(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<CalendarAssemblerResolved> {
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, ownerType === "character" ? ownerId : undefined, "calendar");

  if (!activeSlot.apiConfigId) {
    throw new Error("未绑定日历 API，请先在配置绑定中为日历设置 API。");
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = apiConfigs.find(entry => entry.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new Error("日历 API 配置不存在。");
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(ownerType === "character" ? ownerId : undefined, "calendar");
  const character =
    ownerType === "character"
      ? loadCharacters().find(entry => entry.id === ownerId)
      : buildSyntheticUserCharacter(resolveUserIdentity(undefined, "calendar"));

  if (!character) {
    throw new Error("日历目标不存在。");
  }

  const memConfig = loadMemoryConfig();
  let coreMemories = "";
  let longTermMemories = "";
  let recentBlocks: import("./short-term-assembler").RecentBlock[] = [];
  let unifiedRecentItems: import("./short-term-assembler").UnifiedRecentItem[] = [];
  let wbActivationContext = "";

  if (ownerType === "character") {
    const prepared = prepareShortTermContext(ownerId, "calendar", { history: [] });
    recentBlocks = prepared.recentBlocks;
    unifiedRecentItems = prepared.unifiedRecentItems;
    wbActivationContext = prepared.wbActivationContext;
    const [coreResults, longResults] = await Promise.all([
      retrieveCoreMemoriesForPrompt(ownerId, memConfig).catch(() => []),
      retrieveMemoriesForPrompt(ownerId, wbActivationContext, memConfig).catch(() => []),
    ]);
    coreMemories = formatCoreMemories(coreResults);
    longTermMemories = formatLongTermMemories(longResults);
  }

  const scheduleSummary = buildCalendarScheduleMarker(ownerType, ownerId, weekStart);
  const llmMessages = assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "calendar",
    scheduleSummary,
    coreMemories,
    longTermMemories,
    worldBookActivationContext: wbActivationContext || undefined,
    recentBlocks,
    unifiedRecentItems,
    customStickerNames: ownerType === "character" ? getCustomStickerNames(ownerId) : "",
    customStickerExample: ownerType === "character" ? getCustomStickerExample(ownerId) : "",
  } as AssemblerInput);

  return {
    apiConfig,
    preset,
    regexes,
    llmMessages,
    ownerName: character.name,
  };
}

export async function generateWeeklyCalendarSchedule(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  options?: { feedback?: string },
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
  if (ownerType !== "character") {
    return { success: false, error: "用户日程不支持 AI 生成，请手动填写。" };
  }
  const feedback = options?.feedback?.trim() || "";

  // 带反馈模式不预清：模型要看到现有日程才知道改哪里；
  // 无反馈「重新生成」先清掉本周旧的 AI 条目，否则旧日程进提示词会被照抄——失败时恢复。
  const removedGenerated = feedback ? [] : clearGeneratedWeekItems(ownerType, ownerId, weekStart);
  const restoreRemoved = () => restoreCalendarWeekItems(ownerType, ownerId, weekStart, removedGenerated);
  try {
    const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
    const weekDates = getWeekDates(weekStart);
    const clockRule = clockRuleForCharacter(ownerId);
    const triggerInstruction = feedback
      ? buildWeekAdjustInstruction(resolved.ownerName, weekDates, feedback, clockRule)
      : buildCalendarTriggerInstruction(resolved.ownerName, weekDates, clockRule);

    const messages: LLMMessage[] = [
      ...resolved.llmMessages,
      {
        role: "user",
        content: triggerInstruction,
        _debugMeta: { marker: "calendar_trigger" },
      },
    ];

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      messages,
      resolved.regexes,
      { characterName: `日历:${resolved.ownerName}` },
      { appId: "calendar", appTags: ["calendar"] },
    );

    const { items, clearedDates } = parseScheduleLines(rawText, weekStart);
    if (feedback) {
      // 反馈模式：只合并模型输出的日期，没提到的保持原样
      if (items.length === 0 && clearedDates.size === 0) {
        return { success: false, error: "调整结果为空，或格式无法解析。" };
      }
      applyGeneratedItemsMerge(ownerType, ownerId, weekStart, items, [...clearedDates]);
      return { success: true, items };
    }
    if (items.length === 0) {
      restoreRemoved();
      return { success: false, error: "日历生成结果为空，或格式无法解析。" };
    }

    cloneWeekPlanWithManualEdits(ownerType, ownerId, weekStart, items);
    return { success: true, items };
  } catch (error) {
    restoreRemoved();
    const err = error as ChatEngineError | Error;
    return { success: false, error: err?.message || "生成日历失败" };
  }
}

/** 单日重排：当天现有安排进提示词，按反馈修改（无反馈则换一版）。不预清，成功才落库。 */
export async function generateDayCalendarSchedule(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  date: string,
  feedback?: string,
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
  if (ownerType !== "character") {
    return { success: false, error: "用户日程不支持 AI 生成，请手动填写。" };
  }
  try {
    const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
    const dayItems = (loadCalendarWeekPlan(ownerType, ownerId, weekStart)?.items ?? [])
      .filter(item => item.date === date && item.source !== "manual");
    const triggerInstruction = buildDayTriggerInstruction(
      resolved.ownerName,
      date,
      dayItems,
      clockRuleForCharacter(ownerId),
      feedback,
    );

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      [
        ...resolved.llmMessages,
        { role: "user", content: triggerInstruction, _debugMeta: { marker: "calendar_trigger" } },
      ],
      resolved.regexes,
      { characterName: `日历:${resolved.ownerName}` },
      { appId: "calendar", appTags: ["calendar"] },
    );

    const { items, clearedDates } = parseScheduleLines(rawText, weekStart);
    const dayResult = items.filter(item => item.date === date);
    const cleared = clearedDates.has(date);
    if (dayResult.length === 0 && !cleared) {
      return { success: false, error: "重排结果为空，或格式无法解析。" };
    }
    applyGeneratedItemsMerge(ownerType, ownerId, weekStart, dayResult, cleared ? [date] : []);
    return { success: true, items: dayResult };
  } catch (error) {
    const err = error as ChatEngineError | Error;
    return { success: false, error: err?.message || "重排日程失败" };
  }
}

export async function previewCalendarPromptPayload(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  if (ownerType !== "character") {
    throw new Error("用户日程不支持 AI 生成预览。");
  }
  const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
  const weekDates = getWeekDates(weekStart);
  const triggerInstruction = buildCalendarTriggerInstruction(
    resolved.ownerName,
    weekDates,
    clockRuleForCharacter(ownerId),
  );

  const messages: LLMMessage[] = [
    ...resolved.llmMessages,
    {
      role: "user",
      content: triggerInstruction,
      _debugMeta: { marker: "calendar_trigger" },
    },
  ];

  const apiMessages = previewMessagesForApi(resolved.apiConfig, resolved.preset, messages);
  return {
    messages: apiMessages,
    characterName: `日历:${resolved.ownerName}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "(无预设)",
  };
}

export function createDefaultScheduleDraft(date: string) {
  return {
    date,
    weekday: getWeekdayLabel(date),
    startTime: "09:00",
    endTime: "10:00",
    location: "",
    title: "",
    emoji: "",
    source: "manual" as const,
  };
}

export function getCurrentWeekStart(): string {
  return getWeekStartIso(new Date());
}
