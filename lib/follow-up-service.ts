/**
 * Background follow-up service.
 * Runs independently of any React component — fires follow-ups
 * even when the user is not inside the chat room.
 * Messages are saved to storage; UI is notified via CustomEvent.
 */

import {
    loadChatSessions,
    loadChatMessages,
    pushChatMessage,
    saveChatSessions,
    loadAllFollowUpSchedules,
    saveFollowUpSchedule,
    clearFollowUpSchedule,
    updateMessageMediaStatus,
    updateMessageMediaData,
    createResponseBatchId,
    getLatestCharacterStateValues,
    applyAssistantPartGuards,
} from "./chat-storage";
import type { ChatMessage, ChatSession, StateValue } from "./chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { generateGroupChatCompletion } from "./group-chat-engine";
import { isWithinPushQuietHours, isWithinQuietHours } from "./quiet-hours";
import {
    effectiveIdleIntervalMinutes,
    IDLE_RECONNECT_MAX_CONSECUTIVE,
    loadIdleReconnectRules,
    markIdleReconnectFired,
    resetIdleReconnectForSession,
    suppressIdleReconnectUntil,
    type IdleReconnectRule,
} from "./idle-reconnect-storage";
import { hasActiveGenerationLock } from "./chat-generation-lock";
import { autoTranslateUnbilingualReplies } from "./chat-auto-translate";
import { loadFollowUpConfig } from "./settings-storage";
import { parseAIResponse } from "./rich-message-parser";
import type { ParsedMessagePart } from "./rich-message-parser";
import { isKnownStickerLabel } from "./sticker-data";
import { loadCharacters } from "./character-storage";
import { bgSetInterval, bgSetTimeout } from "./bg-timer";
import { dispatchChatMessageNotice } from "./chat-notification-events";
import { settleShoppingPaymentRequest } from "./shopping-payment-request";
import {
    createPendingChatGeneratedImageData,
    generateAndApplyChatGeneratedImage,
    isPendingChatGeneratedImageMessage,
} from "./generated-image-retry";
import {
    loadTimedWakeSchedules,
    removeTimedWakeSchedule,
    saveTimedWakeSchedule,
    type TimedWakeSchedule,
} from "./timed-wake-storage";
import { clockForCalendarOwner, loadCalendarWeekPlan } from "./calendar-storage";
import { timeToMinutes } from "./calendar-utils";
import { getSystemTimeZone, getZonedClock, normalizeTimeZone, zonedDateTimeToEpoch } from "./character-time";
import { loadDailyWorldPlan, saveDailyWorldPlan } from "./daily-world-storage";
import { triggerImmediatePost } from "./moments-engine";

const INTERACTION_PROPAGATION_INTERVAL_MS = 60_000;
const INTERACTION_PROPAGATION_GRACE_MS = 5 * 60_000;
let lastPropagationPollAt = 0;

/** 传播第二步：互动事件结束后，参与者角色"有感而发"发条朋友圈。
 *  发帖管线本身已注入今日世界 marker（含该互动+结果），内容自然围绕事件发散。
 *  每个互动最多触发一次（generatedContentRefs 记录），安静时段照常受门控。 */
function zoneOfParticipant(characterId: string, chars: ReturnType<typeof loadCharacters>): string {
    if (characterId === "__user__") return getSystemTimeZone();
    return normalizeTimeZone(chars.find(character => character.id === characterId)?.timeZone) || getSystemTimeZone();
}

function pollInteractionPropagation(now: number) {
    if (now - lastPropagationPollAt < INTERACTION_PROPAGATION_INTERVAL_MS) return;
    lastPropagationPollAt = now;

    const at = new Date(now);
    const chars = loadCharacters();
    const dates = new Set<string>([getZonedClock(null, at).dateIso]);
    for (const character of chars) dates.add(getZonedClock(character.timeZone, at).dateIso);

    for (const today of dates) {
        const plan = loadDailyWorldPlan(today);
        if (!plan) continue;

        let dirty = false;
        for (const it of plan.interactions) {
            if (!it.endTime || !/^\d{1,2}:\d{2}$/.test(it.endTime)) continue;
            const target = it.participantIds.find(id => id !== "__user__");
            if (!target) continue;
            const zones = new Set(it.participantIds.map(id => zoneOfParticipant(id, chars)));
            // One shared HH:MM cannot be two zones at once. Same-zone events still fire.
            if (zones.size > 1) continue;
            const targetZone = zoneOfParticipant(target, chars);
            if (plan.date !== getZonedClock(targetZone, at).dateIso) continue;
            const [eh, em] = it.endTime.split(":").map(Number);
            if (Number.isNaN(eh) || Number.isNaN(em)) continue;
            const endAt = zonedDateTimeToEpoch(plan.date, eh * 60 + em, targetZone);
            if (!Number.isFinite(endAt) || now < endAt + INTERACTION_PROPAGATION_GRACE_MS) continue;
            if (it.generatedContentRefs?.length) continue;
            if (isWithinQuietHours(now, target)) continue;

            it.generatedContentRefs = [`moment:${target}`];
            dirty = true;
            console.log(`[DailyWorld] interaction ended → moment post for ${target}: ${it.what}`);
            triggerImmediatePost(target);
        }
        if (dirty) saveDailyWorldPlan(plan);
    }
}

/** 日程忙碌门控：角色当前日程 busyLevel>=2（上课/开会/深度专注）时，
 *  主动消息（追问/定时唤醒）推迟到该日程结束后 1 分钟——"在上课所以下课才回"。
 *  用户主动发消息不受影响（角色会正常回复并在对话里体现当前活动）。 */
function busyDeferUntil(characterId: string | undefined, nowMs: number): number | null {
    if (!characterId) return null;
    const clock = clockForCalendarOwner("character", characterId, new Date(nowMs));
    const plan = loadCalendarWeekPlan("character", characterId, clock.weekStartIso);
    if (!plan) return null;
    for (const item of plan.items) {
        if (item.date !== clock.dateIso) continue;
        if ((item.busyLevel ?? 0) < 2) continue;
        const start = timeToMinutes(item.startTime);
        const end = timeToMinutes(item.endTime);
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
        if (start <= clock.minutes && clock.minutes < end) {
            const endAt = zonedDateTimeToEpoch(clock.dateIso, end, clock.timeZone);
            if (!Number.isFinite(endAt)) return null;
            return endAt + 60_000;
        }
    }
    return null;
}
import {
    getMenstrualPeriodCareEvent,
    hasMenstrualPeriodCareTriggered,
    loadMenstrualConfig,
    loadMenstrualRecords,
    saveMenstrualPeriodCareTrigger,
    type MenstrualPeriodCareEvent,
} from "./menstrual-storage";

// ── Constants ──────────────────────────────────────────────
const MAX_FOLLOW_UPS = 10;
const POLL_INTERVAL_MS = 3000; // check every 3 s
const PERIOD_CARE_POLL_INTERVAL_MS = 60_000;
const BACKGROUND_MESSAGE_STAGGER_MS = 800;

function resolveFollowUpSenderName(sessionId: string): string {
    const sess = loadChatSessions().find(s => s.id === sessionId);
    if (!sess) return "角色";
    if (sess.isGroup) return sess.groupName?.trim() || "群聊";
    const alias = sess.alias?.trim();
    if (alias) return alias;
    return loadCharacters().find(character => character.id === sess.contactId)?.name?.trim() || "角色";
}

function resolveTimedWakeElapsedMinutes(sched: TimedWakeSchedule, history: ChatMessage[], atMs: number): number {
    if (sched.source === "user") {
        const lastUser = [...history].reverse().find(message => message.role === "user");
        const lastUserAt = lastUser ? Date.parse(lastUser.createdAt) : sched.createdAt;
        return Math.max(1, Math.round((atMs - lastUserAt) / 60000));
    }
    return Math.max(1, Math.round((atMs - sched.createdAt) / 60000));
}

// ── Module state ───────────────────────────────────────────
let stopInterval: (() => void) | null = null;
let periodCareUpdateHandler: (() => void) | null = null;
const firingSet = new Set<string>(); // sessions currently mid-API-call
const cancelledWhileFiring = new Set<string>(); // cancelled during in-flight API call
const timedWakeFiringSet = new Set<string>();
const periodCareFiringSet = new Set<string>();
const backgroundReplyFiringSet = new Set<string>();
// 正在后台生成回复的会话（追问/定时唤醒/经期关心/统一后台回复）。
// 聊天室挂载时查询它：中途进入也能立刻显示「正在输入」，补上事件错过的缝
const backgroundGeneratingSessions = new Set<string>();
const cancelledBackgroundSessions = new Set<string>();

/** 该会话是否正有后台回复在生成（聊天室中途挂载时用来恢复输入中状态）。 */
export function isBackgroundReplyGenerating(sessionId: string): boolean {
    return backgroundGeneratingSessions.has(sessionId);
}

export function cancelBackgroundGeneration(sessionId: string): void {
    if (!backgroundGeneratingSessions.has(sessionId) && !firingSet.has(sessionId)) return;
    cancelledBackgroundSessions.add(sessionId);
    if (firingSet.has(sessionId)) cancelledWhileFiring.add(sessionId);
}

function isBackgroundGenerationCancelled(sessionId: string): boolean {
    return cancelledBackgroundSessions.has(sessionId);
}
let lastPeriodCarePollAt = 0;

// ── Public API ─────────────────────────────────────────────

export function startFollowUpService() {
    if (stopInterval) return; // already running
    console.log("[FollowUp] Service started, polling every", POLL_INTERVAL_MS, "ms");
    stopInterval = bgSetInterval(pollSchedules, POLL_INTERVAL_MS);
    if (typeof window !== "undefined") {
        periodCareUpdateHandler = () => {
            lastPeriodCarePollAt = 0;
            pollMenstrualPeriodCare(Date.now());
        };
        window.addEventListener("menstrual-period-care-updated", periodCareUpdateHandler);
    }
}

export function stopFollowUpService() {
    if (stopInterval) { stopInterval(); stopInterval = null; }
    if (typeof window !== "undefined" && periodCareUpdateHandler) {
        window.removeEventListener("menstrual-period-care-updated", periodCareUpdateHandler);
        periodCareUpdateHandler = null;
    }
}

/** Schedule a follow-up for a session (called by ChatRoom after AI replies).
 *  Purely anxiety-driven: no anxiety field or below threshold → no follow-up. */
export function scheduleFollowUp(sessionId: string, count: number, stateValues?: StateValue[]) {
    const config = loadFollowUpConfig();

    if (!stateValues || stateValues.length === 0) {
        console.log(`[FollowUp] No state values, not scheduling.`);
        clearFollowUpSchedule(sessionId);
        return;
    }

    const anxietyEntry = stateValues.find(sv => sv.name === config.anxietyFieldName);
    if (!anxietyEntry) {
        console.log(`[FollowUp] No "${config.anxietyFieldName}" field found, not scheduling.`);
        clearFollowUpSchedule(sessionId);
        return;
    }

    if (anxietyEntry.value < config.anxietyThreshold) {
        console.log(`[FollowUp] Anxiety ${anxietyEntry.value} < threshold ${config.anxietyThreshold}, not scheduling.`);
        clearFollowUpSchedule(sessionId);
        return;
    }

    // Linear interpolation: threshold → maxDelay, 100 → minDelay
    const range = 100 - config.anxietyThreshold;
    const t = range > 0 ? (anxietyEntry.value - config.anxietyThreshold) / range : 1;
    const delaySec = Math.round(config.anxietyMaxDelay + t * (config.anxietyMinDelay - config.anxietyMaxDelay));
    const fireAt = Date.now() + delaySec * 1000;
    console.log(`[FollowUp] Anxiety-driven: value=${anxietyEntry.value}, delay=${delaySec}s, session=${sessionId}, count=${count}`);
    saveFollowUpSchedule({ sessionId, fireAt, count, delaySec });
}

export async function requestBackgroundChatReply(sessionId: string): Promise<{ ok: boolean; skipped?: string }> {
    if (backgroundReplyFiringSet.has(sessionId)) return { ok: false, skipped: "already_running" };
    if (hasActiveGenerationLock(sessionId)) return { ok: false, skipped: "room_generating" };
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session) return { ok: false, skipped: "missing_session" };

    backgroundReplyFiringSet.add(sessionId);
    try {
        const latestMessages = loadChatMessages(session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));
        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            { appTags: session.isGroup ? undefined : ["chat", "text"] },
        );
        if (isBackgroundGenerationCancelled(session.id)) return { ok: false, skipped: "cancelled" };
        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        if (hasVisible) scheduleFollowUp(session.id, 0, stateValues);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
        return { ok: true };
    } catch (error: any) {
        console.error("[BackgroundReply] Error:", error);
        pushChatMessage({
            sessionId,
            role: "system",
            content: `⚠️ 后台回复失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId } }));
        return { ok: false };
    } finally {
        backgroundGeneratingSessions.delete(sessionId);
        cancelledBackgroundSessions.delete(sessionId);
        backgroundReplyFiringSet.delete(sessionId);
    }
}

/** Cancel any pending follow-up for a session (called when user sends a message). */
export function cancelFollowUp(sessionId: string) {
    clearFollowUpSchedule(sessionId);
    // 用户发了消息：冷场重连计数清零
    resetIdleReconnectForSession(sessionId);
    // If an API call is already in-flight, mark it for cancellation
    if (firingSet.has(sessionId)) {
        cancelledWhileFiring.add(sessionId);
    }
}

// ── Internals ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    // Worker 定时器：iOS 后台会冻结主线程 setTimeout，逐条弹出的间隔若用它，
    // 多气泡回复的保存流程会卡在后台直到回前台
    return new Promise<void>(resolve => { bgSetTimeout(resolve, ms); });
}

async function dispatchBackgroundMessagesOneByOne(sessionId: string, messages: ChatMessage[], immediate = false) {
    for (let index = 0; index < messages.length; index += 1) {
        if (index > 0 && !immediate) await delay(BACKGROUND_MESSAGE_STAGGER_MS);
        window.dispatchEvent(new CustomEvent("followup-message-saved", {
            detail: { sessionId, message: messages[index] },
        }));
    }
}

type BackgroundCompletionRound = {
    text: string;
    responseBatchId?: string;
    rawResponseText?: string;
    reasoningText?: string;
};

async function generateBackgroundCompletionRounds(
    session: Parameters<typeof generateChatCompletion>[0],
    messages: Parameters<typeof generateChatCompletion>[1],
    options: Parameters<typeof generateChatCompletion>[2],
): Promise<BackgroundCompletionRound[]> {
    const rounds: BackgroundCompletionRound[] = [];
    // 每轮 LLM 调用的思维链：onReasoning 先于该轮 onTextPart 触发，挂到该轮文本上
    let pendingReasoning: string | undefined;
    const result = await generateChatCompletion(session, messages, options, {
        onReasoning: (t) => { pendingReasoning = t; },
        onTextPart: (text, _senderInfo, meta) => {
            if (!text.trim()) return;
            const reasoningText = pendingReasoning;
            pendingReasoning = undefined;
            rounds.push({
                text,
                responseBatchId: meta?.responseBatchId,
                rawResponseText: meta?.rawResponseText ?? text,
                reasoningText,
            });
        },
    });
    if (rounds.length === 0) {
        const fallback = flattenCompletionResult(result);
        if (fallback.trim()) rounds.push({ text: fallback, rawResponseText: fallback, reasoningText: pendingReasoning });
    }
    return rounds;
}

async function saveBackgroundCompletionRounds(
    rounds: BackgroundCompletionRound[],
    sessionId: string,
    currentCount: number,
    followUpIndex: number | undefined,
    contextMessages: ChatMessage[],
    options?: { senderCharacterId?: string; senderName?: string; silent?: boolean },
): Promise<{ hasVisible: boolean; newCount: number; stateValues: StateValue[] }> {
    let hasVisible = false;
    let newCount = currentCount;
    let stateValues: StateValue[] = [];
    for (const round of rounds) {
        const result = await parseAndSaveResponse(
            round.text,
            sessionId,
            currentCount,
            followUpIndex,
            contextMessages,
            {
                ...options,
                responseBatchId: round.responseBatchId,
                rawResponseText: round.rawResponseText,
                reasoningText: round.reasoningText,
            },
        );
        if (result.hasVisible) {
            hasVisible = true;
            newCount = result.newCount;
        } else if (!hasVisible) {
            newCount = result.newCount;
        }
        if (result.stateValues.length > 0) {
            stateValues = result.stateValues;
        }
    }
    return { hasVisible, newCount, stateValues };
}

function pollSchedules() {
    try {
        const schedules = loadAllFollowUpSchedules();
        const now = Date.now();
        // 安静时段：所有"角色主动"类任务（追问/定时唤醒/经期关怀/冷场重连）都暂停，
        // 出时段后按已过期的 fireAt 自然触发，不丢消息。
        // 角色专属安静时段优先于全局：会话 → contactId 查每个角色的覆盖设置。
        const sessionCharMap = new Map(loadChatSessions().map(s => [s.id, s.contactId] as const));
        for (const sched of schedules) {
            if (sched.fireAt > now) {
                const remainSec = Math.round((sched.fireAt - now) / 1000);
                if (remainSec % 10 === 0) console.log(`[FollowUp] Waiting: session=${sched.sessionId}, ${remainSec}s remaining`);
                continue;
            }
            if (isWithinQuietHours(now, sessionCharMap.get(sched.sessionId))) continue;
            const charId = sessionCharMap.get(sched.sessionId);
            const deferUntil = busyDeferUntil(charId, now);
            if (deferUntil) {
                sched.fireAt = deferUntil;
                saveFollowUpSchedule(sched);
                continue;
            }
            // 房间正在生成回复时避让：两边同时写消息会并发双发、顺序错乱
            if (hasActiveGenerationLock(sched.sessionId)) {
                sched.fireAt = now + 60_000;
                saveFollowUpSchedule(sched);
                continue;
            }
            if (firingSet.has(sched.sessionId)) continue; // already in-flight
            console.log(`[FollowUp] Firing now for session=${sched.sessionId}, count=${sched.count}`);
            fireFollowUp(sched); // intentionally not awaited — fire & forget
        }
        pollTimedWakeSchedules(now);
        pollMenstrualPeriodCare(now);
        pollInteractionPropagation(now);
        pollIdleReconnect(now);
        pollGroupAutoChat(now);
    } catch (e) {
        console.error("[FollowUp] pollSchedules error:", e);
    }
}

function pollTimedWakeSchedules(now: number) {
    const schedules = loadTimedWakeSchedules();
    for (const sched of schedules) {
        if (sched.fireAt > now) continue;
        if (timedWakeFiringSet.has(sched.id)) continue;
        if (isWithinQuietHours(now, sched.characterId)) continue;
        const wakeDeferUntil = busyDeferUntil(sched.characterId, now);
        if (wakeDeferUntil) {
            sched.fireAt = wakeDeferUntil;
            saveTimedWakeSchedule(sched);
            continue;
        }
        // 房间正在生成回复时避让（下一轮 3s 轮询自然重试）
        if (hasActiveGenerationLock(sched.sessionId)) continue;
        console.log(`[TimedWake] Firing now for session=${sched.sessionId}`);
        fireTimedWake(sched);
    }
}

function pollMenstrualPeriodCare(now: number) {
    if (now - lastPeriodCarePollAt < PERIOD_CARE_POLL_INTERVAL_MS) return;
    lastPeriodCarePollAt = now;

    const config = loadMenstrualConfig();
    if (!config.periodCareEnabled || config.periodCareCharacterIds.length === 0) return;

    const records = loadMenstrualRecords();
    const event = getMenstrualPeriodCareEvent(records, config);
    if (!event) return;

    const selectedIds = new Set(config.periodCareCharacterIds);
    const sessions = loadChatSessions()
        .filter(session => !session.isGroup && selectedIds.has(session.contactId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latestSessionByCharacter = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
        if (!latestSessionByCharacter.has(session.contactId)) {
            latestSessionByCharacter.set(session.contactId, session);
        }
    }

    for (const characterId of selectedIds) {
        if (hasMenstrualPeriodCareTriggered(characterId, event.cycleKey)) continue;
        if (isWithinQuietHours(now, characterId)) continue;
        const session = latestSessionByCharacter.get(characterId);
        if (!session) continue;
        const firingKey = `${characterId}:${event.cycleKey}`;
        if (periodCareFiringSet.has(firingKey)) continue;
        console.log(`[PeriodCare] Firing now for session=${session.id}, cycle=${event.cycleKey}`);
        fireMenstrualPeriodCare({
            sessionId: session.id,
            characterId,
            event,
        });
    }
}

async function fireFollowUp(sched: { sessionId: string; count: number; delaySec?: number }) {
    if (sched.count >= MAX_FOLLOW_UPS) {
        clearFollowUpSchedule(sched.sessionId);
        return;
    }

    firingSet.add(sched.sessionId);
    clearFollowUpSchedule(sched.sessionId); // clear before firing

    try {
        const sessions = loadChatSessions();
        const session = sessions.find(s => s.id === sched.sessionId);
        if (!session) return;

        const latestMessages = loadChatMessages(session.id);

        // 用户刚说了话还没被回复：此刻插一条"你怎么不回我"的追问既不礼貌，
        // 还会把最后一条变成 assistant，吃掉「收起键盘自动回复」的触发条件——
        // 顺延 60s 让正常回复先生效。用户消息已冷 >3min 才照原计划追（上游
        // 回复链路可能已失效，追问兜底好过沉默）。
        const lastNonSystem = [...latestMessages].reverse().find(m => m.role !== "system");
        if (lastNonSystem?.role === "user" && Date.now() - Date.parse(lastNonSystem.createdAt) < 3 * 60_000) {
            saveFollowUpSchedule({
                sessionId: sched.sessionId,
                fireAt: Date.now() + 60_000,
                count: sched.count,
                delaySec: sched.delaySec,
            });
            return;
        }

        const count = sched.count + 1;

        // Find the last user message timestamp to calculate silence duration
        const lastUserMsg = [...latestMessages].reverse().find(m => m.role === "user");
        const lastUserTime = lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : Date.now();

        // Build message list with follow-up round markers so AI knows its history
        const annotatedMessages: ChatMessage[] = [];
        let currentRound = 0;
        for (const msg of latestMessages) {
            // When we encounter a new follow-up round, insert a marker
            if (msg.role === "assistant" && msg.followUpIndex && msg.followUpIndex > currentRound) {
                currentRound = msg.followUpIndex;
                const markerTime = new Date(msg.createdAt).getTime();
                const silenceSec = Math.round((markerTime - lastUserTime) / 1000);
                annotatedMessages.push({
                    id: `_marker_${currentRound}_${Date.now()}`,
                    sessionId: session.id,
                    role: "user",
                    content: `[对方没有回复你的消息，距上次回复已过约${silenceSec}秒]`,
                    status: "sent",
                    createdAt: msg.createdAt,
                });
            }
            annotatedMessages.push(msg);
        }

        const nowMs = Date.now();
        const finalSilenceSec = Math.round((nowMs - lastUserTime) / 1000);
        const messagesWithHint: ChatMessage[] = [
            ...annotatedMessages,
            {
                id: `_silence_${nowMs}`,
                sessionId: session.id,
                role: "system",
                content: `[对方没有回复你的消息，距上次回复已过约${finalSilenceSec}秒]`,
                status: "sent",
                createdAt: new Date().toISOString(),
            },
        ];

        // Notify UI that follow-up generation is starting (typing indicator)
        console.log("[FollowUp] Dispatching followup-started for session:", session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        const rounds = await generateBackgroundCompletionRounds(
            session,
            messagesWithHint,
            { followUpCount: count, followUpDelay: sched.delaySec ?? 60, appTags: ["chat", "text", "followup"] },
        );

        // User sent a message while we were waiting for the API — discard result
        if (cancelledWhileFiring.has(sched.sessionId) || isBackgroundGenerationCancelled(sched.sessionId)) {
            console.log(`[FollowUp] Cancelled during API call, discarding result for session=${sched.sessionId}`);
            cancelledWhileFiring.delete(sched.sessionId);
            return;
        }

        const { hasVisible, newCount, stateValues } = await saveBackgroundCompletionRounds(rounds, session.id, sched.count, count, latestMessages);
        console.log(`[FollowUp] Result: hasVisible=${hasVisible}, newCount=${newCount}`);

        if (hasVisible && newCount < MAX_FOLLOW_UPS) {
            scheduleFollowUp(session.id, newCount, stateValues);
        }

        // Notify any mounted UI
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));

    } catch (error: any) {
        console.error(`[FollowUp] Error:`, error);
        pushChatMessage({
            sessionId: sched.sessionId,
            role: "system",
            content: `⚠️ 追发失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: sched.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(sched.sessionId);
        cancelledBackgroundSessions.delete(sched.sessionId);
        firingSet.delete(sched.sessionId);
        cancelledWhileFiring.delete(sched.sessionId);
    }
}

// ── 冷场重连：用户长时间没消息 → 角色主动发一次（连发上限内可重复） ──

const idleReconnectFiringSet = new Set<string>();
let lastIdleReconnectPollAt = 0;
const IDLE_RECONNECT_POLL_INTERVAL_MS = 60_000;

function pollIdleReconnect(now: number) {
    if (now - lastIdleReconnectPollAt < IDLE_RECONNECT_POLL_INTERVAL_MS) return;
    lastIdleReconnectPollAt = now;

    for (const rule of loadIdleReconnectRules()) {
        if (idleReconnectFiringSet.has(rule.id)) continue;
        if (firingSet.has(rule.sessionId)) continue;
        // 追问链正在管这个会话时不叠加打扰
        if (loadAllFollowUpSchedules().some(sched => sched.sessionId === rule.sessionId)) continue;

        const messages = loadChatMessages(rule.sessionId);
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        if (!lastUser) continue;
        const lastUserAt = new Date(lastUser.createdAt).getTime();

        const effectiveConsecutive = rule.lastFiredAt && rule.lastFiredAt > lastUserAt ? rule.consecutiveCount : 0;
        if (effectiveConsecutive >= IDLE_RECONNECT_MAX_CONSECUTIVE) continue;

        const intervalMs = effectiveIdleIntervalMinutes(rule) * 60_000;
        const nextDueAt = Math.max(
            lastUserAt + intervalMs,
            rule.lastFiredAt ? rule.lastFiredAt + intervalMs : 0,
            rule.suppressedUntil ?? 0,
        );
        if (now < nextDueAt) continue;
        if (isWithinQuietHours(now, rule.characterId)) continue; // 安静时段（含角色专属）不打扰，出时段后自然触发
        if (hasActiveGenerationLock(rule.sessionId)) continue; // 房间正在回复，避让（下个轮询周期再来）

        console.log(`[IdleReconnect] Firing for session=${rule.sessionId}, idle=${Math.round((now - lastUserAt) / 60000)}min`);
        void fireIdleReconnect(rule, lastUserAt);
    }
}

async function fireIdleReconnect(rule: IdleReconnectRule, lastUserAt: number) {
    idleReconnectFiringSet.add(rule.id);
    try {
        const session = loadChatSessions().find(s => s.id === rule.sessionId);
        if (!session || session.isGroup || session.contactId !== rule.characterId) return;

        const latestMessages = loadChatMessages(session.id);
        const elapsedMinutes = Math.max(1, Math.round((Date.now() - lastUserAt) / 60000));

        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            {
                appTags: ["chat", "text", "idle_wake"],
                timedWakeElapsedMinutes: elapsedMinutes,
            },
        );

        if (isBackgroundGenerationCancelled(session.id)) {
            const intervalMs = effectiveIdleIntervalMinutes(rule) * 60_000;
            suppressIdleReconnectUntil(rule.id, Date.now() + intervalMs);
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        markIdleReconnectFired(rule.id, Date.now());
        if (hasVisible) scheduleFollowUp(session.id, 0, stateValues);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: unknown) {
        console.error("[IdleReconnect] Error:", error);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: rule.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(rule.sessionId);
        cancelledBackgroundSessions.delete(rule.sessionId);
        idleReconnectFiringSet.delete(rule.id);
    }
}

// ── 群成员自动闲聊 ──
// 每个群会话独立调度：session.groupAutoChat 存 { enabled, minMinutes, maxMinutes, nextFireAt }。
// 到点后生成一轮群聊（成员们自由搭话），处于安静时段（含角色专属）的成员这轮不冒泡。

const GROUP_AUTO_CHAT_MIN_MINUTES = 1;
const GROUP_AUTO_CHAT_DEFAULT_MIN = 8;
const GROUP_AUTO_CHAT_DEFAULT_MAX = 30;
const groupAutoChatFiringSet = new Set<string>();

function groupAutoChatRangeMinutes(cfg: { minMinutes?: number; maxMinutes?: number } | undefined): { min: number; max: number } {
    const min = Math.max(GROUP_AUTO_CHAT_MIN_MINUTES, Math.floor(cfg?.minMinutes ?? GROUP_AUTO_CHAT_DEFAULT_MIN));
    const max = Math.max(min, Math.floor(cfg?.maxMinutes ?? GROUP_AUTO_CHAT_DEFAULT_MAX));
    return { min, max };
}

function rollGroupAutoChatNextAt(cfg: { minMinutes?: number; maxMinutes?: number } | undefined): number {
    const { min, max } = groupAutoChatRangeMinutes(cfg);
    return Date.now() + Math.round((min + Math.random() * (max - min)) * 60_000);
}

function updateGroupAutoChat(sessionId: string, patch: Partial<NonNullable<ChatSession["groupAutoChat"]>>): void {
    const sessions = loadChatSessions();
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return;
    sessions[idx] = {
        ...sessions[idx],
        groupAutoChat: { ...(sessions[idx].groupAutoChat || {}), ...patch },
    };
    saveChatSessions(sessions);
}

function pollGroupAutoChat(now: number) {
    for (const session of loadChatSessions()) {
        const cfg = session.groupAutoChat;
        if (!session.isGroup || !cfg?.enabled) continue;
        const participantIds = session.participantIds ?? [];
        if (participantIds.length === 0) continue;
        if ((cfg.nextFireAt ?? 0) > now) continue;
        if (groupAutoChatFiringSet.has(session.id) || firingSet.has(session.id)
            || backgroundReplyFiringSet.has(session.id) || backgroundGeneratingSessions.has(session.id)) continue;
        if (hasActiveGenerationLock(session.id)) continue; // 房间正在生成回复，避让
        // 全员都在安静时段（含角色专属）→ 这轮不聊，按区间重新排队
        if (participantIds.every(id => isWithinQuietHours(now, id))) {
            updateGroupAutoChat(session.id, { nextFireAt: rollGroupAutoChatNextAt(cfg) });
            continue;
        }
        void fireGroupAutoChat(session.id);
    }
}

async function fireGroupAutoChat(sessionId: string) {
    groupAutoChatFiringSet.add(sessionId);
    // 无论成败先排下一轮，避免接口报错把自动闲聊打死
    const sessionAtFire = loadChatSessions().find(s => s.id === sessionId);
    if (sessionAtFire) {
        updateGroupAutoChat(sessionId, { nextFireAt: rollGroupAutoChatNextAt(sessionAtFire.groupAutoChat) });
    }
    try {
        const session = loadChatSessions().find(s => s.id === sessionId);
        if (!session || !session.isGroup || !session.groupAutoChat?.enabled) return;
        const participantIds = session.participantIds ?? [];
        if (participantIds.length === 0) return;

        const now = Date.now();
        const quietIds = new Set(participantIds.filter(id => isWithinQuietHours(now, id)));
        const activeIds = participantIds.filter(id => !quietIds.has(id));
        if (activeIds.length === 0) return; // 竞态：开火瞬间全员进入安静时段
        const quietNames = quietIds.size > 0
            ? loadCharacters().filter(c => quietIds.has(c.id)).map(c => c.name)
            : [];

        const latestMessages = loadChatMessages(session.id);
        const lastOrder = latestMessages.length > 0
            ? Math.max(...latestMessages.map(m => m.order ?? 0))
            : 0;
        // 临时旁白：不落库，只给本轮生成一个方向
        const nudge: ChatMessage = {
            id: `_group_auto_${Date.now()}`,
            sessionId: session.id,
            role: "system",
            content: `[群聊自由闲聊时间：群成员们主动开启或接续话题互相聊天，不需要等用户发言，也不要每条都@用户${quietNames.length > 0 ? `；本轮 ${quietNames.join("、")} 暂时不在，不要让他们发言` : ""}]`,
            status: "sent",
            createdAt: new Date().toISOString(),
            order: lastOrder + 1,
        };

        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        const results = await generateGroupChatCompletion(session, [...latestMessages, nudge]);

        for (const result of results) {
            // 安静时段（含角色专属）的成员这轮不冒泡（生成期间状态可能变化，落库前再查一次）
            if (isWithinQuietHours(Date.now(), result.characterId)) continue;
            await parseAndSaveResponse(
                result.responseText,
                session.id,
                0,
                undefined,
                latestMessages,
                { senderCharacterId: result.characterId, senderName: result.characterName },
            );
        }
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: unknown) {
        console.error("[GroupAutoChat] Error:", error);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(sessionId);
        cancelledBackgroundSessions.delete(sessionId);
        groupAutoChatFiringSet.delete(sessionId);
    }
}

async function fireTimedWake(sched: TimedWakeSchedule) {
    timedWakeFiringSet.add(sched.id);
    removeTimedWakeSchedule(sched.id);

    try {
        const sessions = loadChatSessions();
        const session = sessions.find(s => s.id === sched.sessionId);
        if (!session || session.contactId !== sched.characterId) return;

        const latestMessages = loadChatMessages(session.id);
        const elapsedMinutes = resolveTimedWakeElapsedMinutes(sched, latestMessages, Date.now());

        console.log("[TimedWake] Dispatching followup-started for session:", session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        // 用户创建的定时只提供沉默时长语境；角色工具约的保留"你当时想着"视角。
        const wakeTag = sched.source === "user" ? "user_timed_wake" : "timed_wake";
        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            {
                appTags: ["chat", "text", wakeTag],
                timedWakeElapsedMinutes: elapsedMinutes,
                timedWakeIntent: sched.intent,
            },
        );

        if (isBackgroundGenerationCancelled(session.id)) {
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        console.log(`[TimedWake] Result: hasVisible=${hasVisible}`);

        if (hasVisible) {
            scheduleFollowUp(session.id, 0, stateValues);
        }

        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: any) {
        console.error("[TimedWake] Error:", error);
        const failureLabel = sched.source === "user" ? "定时主动消息" : "稍后主动联系";
        pushChatMessage({
            sessionId: sched.sessionId,
            role: "system",
            content: `⚠️ ${failureLabel}失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: sched.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(sched.sessionId);
        cancelledBackgroundSessions.delete(sched.sessionId);
        timedWakeFiringSet.delete(sched.id);
    }
}

async function fireMenstrualPeriodCare(input: {
    sessionId: string;
    characterId: string;
    event: MenstrualPeriodCareEvent;
}) {
    const firingKey = `${input.characterId}:${input.event.cycleKey}`;
    periodCareFiringSet.add(firingKey);

    try {
        const sessions = loadChatSessions();
        const session = sessions.find(s => s.id === input.sessionId);
        if (!session || session.isGroup || session.contactId !== input.characterId) return;
        if (hasMenstrualPeriodCareTriggered(input.characterId, input.event.cycleKey)) return;

        const latestMessages = loadChatMessages(session.id);

        console.log("[PeriodCare] Dispatching followup-started for session:", session.id);
        backgroundGeneratingSessions.add(session.id);
        window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));

        const rounds = await generateBackgroundCompletionRounds(
            session,
            latestMessages,
            {
                appTags: ["chat", "text", "period_care"],
                periodCareContext: input.event.context,
            },
        );

        if (isBackgroundGenerationCancelled(session.id)) {
            window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
            return;
        }

        const { hasVisible, stateValues } = await saveBackgroundCompletionRounds(
            rounds,
            session.id,
            0,
            undefined,
            latestMessages,
        );
        saveMenstrualPeriodCareTrigger({
            characterId: input.characterId,
            sessionId: session.id,
            cycleKey: input.event.cycleKey,
        });
        console.log(`[PeriodCare] Result: hasVisible=${hasVisible}`);

        if (hasVisible) {
            scheduleFollowUp(session.id, 0, stateValues);
        }

        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    } catch (error: any) {
        console.error("[PeriodCare] Error:", error);
        pushChatMessage({
            sessionId: input.sessionId,
            role: "system",
            content: `⚠️ 经期关心失败: ${error?.message || String(error)}`,
        });
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: input.sessionId } }));
    } finally {
        backgroundGeneratingSessions.delete(input.sessionId);
        cancelledBackgroundSessions.delete(input.sessionId);
        periodCareFiringSet.delete(firingKey);
    }
}

// ── AI media action handler for follow-up context ──
// （现实桥的后台生成也复用它：收红包/收转账/收代付在后台同样真执行）

export function handleFollowUpMediaAction(
    actionType: string,
    sessionId: string,
    contextMessages: ChatMessage[],
) {
    const targetMediaType = actionType.includes("payment_request")
        ? "payment_request"
        : actionType.includes("red_packet") ? "red_packet" : "transfer";
    const targetMsg = [...contextMessages].reverse().find(
        m => m.role === "user" && m.mediaType === targetMediaType && m.mediaData?.status === "pending"
    );
    if (!targetMsg) return;

    const charName = resolveFollowUpSenderName(sessionId);
    const userName = "你";
    const responseBatchId = createResponseBatchId();

    let newStatus: "opened" | "received" | "declined" | "paid";
    let sysText: string;
    let rawResponseText: string;
    if (actionType === "accept_red_packet") {
        newStatus = "opened";
        sysText = `${charName}领取了${userName}的红包`;
        rawResponseText = `[${charName}领取了${userName}的红包]`;
    } else if (actionType === "decline_red_packet") {
        newStatus = "declined";
        sysText = `${charName}退回了${userName}的红包`;
        rawResponseText = `[${charName}退回了${userName}的红包]`;
    } else if (actionType === "accept_transfer") {
        newStatus = "received";
        sysText = `${charName}已收款`;
        rawResponseText = `[${charName}领取了${userName}的转账]`;
    } else if (actionType === "accept_payment_request") {
        newStatus = "paid";
        sysText = `${charName}接受了${userName}的代付请求`;
        rawResponseText = `[${charName}接受了${userName}的代付]`;
        settleShoppingPaymentRequest({
            orderId: targetMsg.mediaData?.shoppingOrderId,
            requestId: targetMsg.mediaData?.paymentRequestId,
            accepted: true,
            payerCharacterName: charName,
        });
    } else if (actionType === "decline_payment_request") {
        newStatus = "declined";
        sysText = `${charName}拒绝了${userName}的代付请求`;
        rawResponseText = `[${charName}拒绝了${userName}的代付]`;
        settleShoppingPaymentRequest({
            orderId: targetMsg.mediaData?.shoppingOrderId,
            requestId: targetMsg.mediaData?.paymentRequestId,
            accepted: false,
            payerCharacterName: charName,
        });
    } else {
        newStatus = "declined";
        sysText = `${charName}退回了${userName}的转账`;
        rawResponseText = `[${charName}退回了${userName}的转账]`;
    }

    if (targetMediaType === "payment_request") {
        updateMessageMediaData(targetMsg.id, {
            ...targetMsg.mediaData,
            status: newStatus,
            paymentResolvedAt: new Date().toISOString(),
            paymentPayerName: charName,
        });
    } else {
        updateMessageMediaStatus(targetMsg.id, newStatus as "opened" | "received" | "declined");
    }
    pushChatMessage({
        sessionId,
        role: "system",
        content: sysText,
        responseBatchId,
        rawResponseText,
    });
}

// ── Response parser (uses shared parseAIResponse) ──

function buildGeneratedFollowUpImageMessage(
    part: ParsedMessagePart,
): Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData"> {
    const base = {
        content: part.content,
        mediaType: part.mediaType,
        mediaData: part.mediaData,
    };
    if (part.mediaType !== "image") return base;

    const description = part.mediaData?.label?.trim();
    if (!description) return base;

    return {
        ...base,
        mediaData: createPendingChatGeneratedImageData(part.mediaData, description),
    };
}

function canCarryFollowUpPanel(part: ParsedMessagePart): boolean {
    return part.mediaType !== "poke" && part.mediaType !== "group_admin_notice";
}

// 后台保存 AI 回复的统一实现：分条、状态栏/独白、拍一拍、来电、收红包类动作、
// 生图占位、横幅+系统弹窗、逐条弹出。追问/定时唤醒/经期关心/自定义APP/现实桥/
// 朋友圈动作标签都走这里；聊天室前台有自己的原生实现。
// options.senderCharacterId/senderName：群聊消息的发言角色（单聊不传）。
// options.silent：静默落账（离线推送回端合并用）——立即写入全部消息、立即派发事件，
// 不弹横幅/系统通知（推送在设备上已经弹过一遍了）。
export async function parseAndSaveResponse(
    rawText: string,
    sessionId: string,
    currentCount: number,
    followUpIndex: number | undefined,
    contextMessages: ChatMessage[],
    options?: {
        senderCharacterId?: string;
        senderName?: string;
        silent?: boolean;
        responseBatchId?: string;
        /** 离线回端时沿用云端生成时间，避免多轮补账被“当前时间”打乱因果顺序。 */
        createdAt?: string;
        rawResponseText?: string;
        reasoningText?: string;
        /** 这轮回复实际触发过的快捷动作标记：按 insertAt 在原始位置落一对
         *  tool_call（标记原文，组装器原样进上下文、气泡隐藏）+ tool_notice
         *  （可见灰条），与小手机内直接调用快捷动作的显示一致 */
        shortcutMarker?: { text: string; insertAt: number; name: string };
    },
): Promise<{ hasVisible: boolean; newCount: number; stateValues: StateValue[] }> {
    const callStartMs = Date.now();
    const responseBatchId = options?.responseBatchId || createResponseBatchId();
    const rawResponseText = options?.rawResponseText ?? rawText;
    const reasoningText = options?.reasoningText;
    void contextMessages;
    const sessions = loadChatSessions();
    const sess = sessions.find(s => s.id === sessionId);
    const previousState = sess && !sess.isGroup ? getLatestCharacterStateValues(sess.contactId) : [];

    const { parts: parsedParts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(rawText, previousState);
    // [撤回]/复读守卫：主动消息同样过这道（撤回按发送者对齐，群聊不能替别人撤）
    const parts = applyAssistantPartGuards(sessionId, parsedParts, {
        senderCharacterId: sess?.isGroup ? options?.senderCharacterId : sess?.contactId,
    }).parts;

    // Detect call triggers and AI media actions, filter them out (not stored as messages)
    let triggerCall: "voice" | "video" | undefined;
    const charName = resolveFollowUpSenderName(sessionId);

    // 快捷动作配对消息：tool_call 存标记原文（组装器不跳过，历史上下文与模型当初
    // 的输出一致），tool_notice 是用户可见的灰条。按 insertAt 用游标扫描把配对
    // 插回标记原来所在的分条位置，不挪到末尾；找不到对应位置时兜底放在最后。
    const shortcutMarker = options?.shortcutMarker;
    const findShortcutMarkerPartIdx = (parts: ParsedMessagePart[]): number => {
        if (!shortcutMarker) return -1;
        let cursor = 0;
        for (let i = 0; i < parts.length; i++) {
            const probe = (parts[i].content || "").trim();
            const at = probe ? rawText.indexOf(probe, cursor) : -1;
            if (at >= 0) {
                if (at >= shortcutMarker.insertAt) return i;
                cursor = at + probe.length;
            }
        }
        return parts.length;
    };

    const filteredParts: ParsedMessagePart[] = [];
    for (const p of parts) {
        if (p.mediaType === "voice_call") { triggerCall = "voice"; continue; }
        if (p.mediaType === "video_call") { triggerCall = "video"; continue; }
        // 「丢弃角色输出的无效表情包」开关（主动消息路径）
        if (p.mediaType === "sticker" && sess?.discardInvalidStickers === true) {
            const senderIds = sess.isGroup ? (sess.participantIds ?? []) : [sess.contactId];
            if (!isKnownStickerLabel(p.mediaData?.label || "", senderIds)) continue;
        }
        if (p.mediaType === "accept_red_packet" || p.mediaType === "decline_red_packet"
            || p.mediaType === "accept_transfer" || p.mediaType === "decline_transfer"
            || p.mediaType === "accept_payment_request" || p.mediaType === "decline_payment_request") {
            handleFollowUpMediaAction(p.mediaType, sessionId, contextMessages);
            continue;
        }
        if (p.mediaType === "poke") {
            const pokeSender = (p.mediaData?.pokeSender === "我" ? charName : p.mediaData?.pokeSender) || charName;
            const pokeTarget = p.mediaData?.pokeTarget || "你";
            filteredParts.push({
                content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                mediaType: "poke",
                mediaData: { pokeSender, pokeTarget },
            });
            continue;
        }
        filteredParts.push(p);
    }

    // Save call trigger as system message (persists even when user is not in chat room)
    if (triggerCall) {
        const callLabel = triggerCall === "voice" ? "语音通话" : "视频通话";
        pushChatMessage({
            sessionId,
            role: "system",
            content: `[我发起了${callLabel}]`,
            createdAt: options?.createdAt,
            responseBatchId: createResponseBatchId(),
            rawResponseText: `[我发起了${callLabel}]`,
        });
    }

    if (filteredParts.length === 0) {
        if (statusPanel || innerMonologue || reasoningText) {
            pushChatMessage({
                sessionId,
                role: "assistant",
                content: "",
                createdAt: options?.createdAt,
                responseBatchId,
                rawResponseText,
                statusPanel,
                innerMonologue,
                reasoningText,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
                ...(followUpIndex ? { followUpIndex } : {}),
            });
        }
        if (shortcutMarker) {
            const baseMs = options?.createdAt ? Date.parse(options.createdAt) : NaN;
            pushChatMessage({
                sessionId,
                role: "assistant",
                content: shortcutMarker.text,
                createdAt: Number.isFinite(baseMs) ? new Date(baseMs + 1).toISOString() : undefined,
                mediaType: "tool_call",
                responseBatchId,
                senderCharacterId: options?.senderCharacterId,
                senderName: options?.senderName,
            });
            pushChatMessage({
                sessionId,
                role: "system",
                content: `发出快捷动作「${shortcutMarker.name}」`,
                createdAt: Number.isFinite(baseMs) ? new Date(baseMs + 2).toISOString() : undefined,
                mediaType: "tool_notice",
            });
        }
        // Emit call trigger event for chat-room to pick up
        if (triggerCall && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ai-call-trigger", { detail: { sessionId, type: triggerCall } }));
        }
        return { hasVisible: false, newCount: MAX_FOLLOW_UPS, stateValues };
    }

    const savedMessages: ChatMessage[] = [];
    const imageReplacementTasks: Promise<unknown>[] = [];
    let metaIdx = filteredParts.findIndex(canCarryFollowUpPanel);
    if (metaIdx === -1 && (statusPanel || innerMonologue || reasoningText || stateValues.length > 0)) {
        filteredParts.push({ content: "" });
        metaIdx = filteredParts.length - 1;
    }
    const markerPartIdx = findShortcutMarkerPartIdx(filteredParts);
    // 时间戳按落库顺序递增（配对消息插在中间时也保持因果顺序）
    let timeSeq = 0;
    const nextCreatedAt = (): string | undefined => {
        const sourceCreatedAt = options?.createdAt ? Date.parse(options.createdAt) : NaN;
        const seq = timeSeq++;
        return Number.isFinite(sourceCreatedAt) ? new Date(sourceCreatedAt + seq).toISOString() : undefined;
    };
    const saveShortcutMarkerPair = () => {
        if (!shortcutMarker) return;
        savedMessages.push(pushChatMessage({
            sessionId,
            role: "assistant",
            content: shortcutMarker.text,
            createdAt: nextCreatedAt(),
            mediaType: "tool_call",
            responseBatchId,
            senderCharacterId: options?.senderCharacterId,
            senderName: options?.senderName,
        }));
        savedMessages.push(pushChatMessage({
            sessionId,
            role: "system",
            content: `发出快捷动作「${shortcutMarker.name}」`,
            createdAt: nextCreatedAt(),
            mediaType: "tool_notice",
        }));
    };
    for (let i = 0; i < filteredParts.length; i++) {
        if (i === markerPartIdx) saveShortcutMarkerPair();
        const generatedPart = buildGeneratedFollowUpImageMessage(filteredParts[i]);
        const createdAt = nextCreatedAt();
        const saved = pushChatMessage({
            sessionId,
            role: "assistant",
            content: generatedPart.content,
            createdAt,
            mediaType: generatedPart.mediaType,
            mediaUrl: generatedPart.mediaUrl,
            mediaData: generatedPart.mediaData,
            responseBatchId,
            rawResponseText,
            statusPanel: i === metaIdx && statusPanel ? statusPanel : undefined,
            innerMonologue: i === metaIdx && innerMonologue ? innerMonologue : undefined,
            reasoningText: i === metaIdx ? reasoningText : undefined,
            stateValues: i === metaIdx && stateValues.length > 0 ? stateValues : undefined,
            freshStateValues: i === metaIdx ? freshStateValues : undefined,
            senderCharacterId: options?.senderCharacterId,
            senderName: options?.senderName,
            ...(followUpIndex ? { followUpIndex } : {}),
        });
        if (isPendingChatGeneratedImageMessage(saved)) {
            imageReplacementTasks.push(
                generateAndApplyChatGeneratedImage(saved, sess?.contactId)
                    .catch(error => {
                        console.warn("[FollowUp] Image generation failed:", error);
                        return null;
                    }),
            );
        }
        savedMessages.push(saved);
    }
    if (markerPartIdx >= filteredParts.length) saveShortcutMarkerPair();

    await dispatchBackgroundMessagesOneByOne(sessionId, savedMessages, options?.silent === true);
    if (imageReplacementTasks.length > 0) {
        await Promise.allSettled(imageReplacementTasks);
    }

    // 与聊天室前台切后台时同节奏的双通道提醒：横幅 + 系统弹窗成对、
    // 按 800ms 逐条发（与气泡逐条弹出同拍；Worker 定时器保证后台锁屏也按节奏到达）
    // 静默模式（回端合并）不再重复提醒——系统推送已经弹过了
    if (filteredParts.length > 0 && options?.silent !== true) {
        const isGroup = sess?.isGroup === true;
        const avatar = isGroup
            ? (options?.senderCharacterId
                ? loadCharacters().find(c => c.id === options.senderCharacterId)?.avatar || null
                : null)
            : (sess ? loadCharacters().find(c => c.id === sess.contactId)?.avatar || null : null);
        const bodyPrefix = isGroup && options?.senderName ? `${options.senderName}: ` : "";
        const partBody = (part: ParsedMessagePart) => bodyPrefix + ((part.content || "").trim()
            || (part.mediaType === "image" && part.mediaData?.label ? `发了一张照片: ${part.mediaData.label}` : "发来一条消息"));
        const { sendBrowserNotification } = await import("./browser-notification");
        filteredParts.forEach((part, index) => {
            bgSetTimeout(() => {
                dispatchChatMessageNotice({
                    sessionId,
                    senderName: charName,
                    body: partBody(part).slice(0, 80),
                    avatar,
                    ...(isGroup ? { isGroup: true } : {}),
                });
                sendBrowserNotification(charName, { body: partBody(part).slice(0, 60), icon: avatar || undefined });
            }, index * BACKGROUND_MESSAGE_STAGGER_MS);
        });
    }

    // Emit call trigger event for chat-room to pick up
    if (triggerCall && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ai-call-trigger", { detail: { sessionId, type: triggerCall } }));
    }

    // 双语兜底:模型掉格式(没输出 原文|译文)的文本气泡自动补译。离线回端合并的
    // 消息沿用云端时间戳,since 下探到本批最早时间保证也被检查;fire-and-forget
    const cloudMs = options?.createdAt ? Date.parse(options.createdAt) : NaN;
    autoTranslateUnbilingualReplies(
        sessionId,
        Number.isFinite(cloudMs) ? Math.min(cloudMs, callStartMs) : callStartMs,
    );

    return { hasVisible: true, newCount: currentCount + 1, stateValues };
}
