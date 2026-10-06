// lib/prompt-dedupe.ts
// 提示词侧的历史折叠守卫：把历史里高度重复的 assistant 纯文本气泡折叠成一条。
//
// 为什么需要：模型一旦开始复读，那一句会被存进历史，下一轮又原样喂回去——
// 历史里出现"同一句话连发 N 遍"时，模型会把上一句当成续写锚点继续复读，
// 形成存储↔提示词的自我强化回路，改存档也断不掉（复读守卫会保底留一条）。
// 这里在组装提示词之前把重复项去掉：内容不丢（同一句话仍保留一条），
// 只是不再把它们堆在模型眼前当范文。
//
// 注意：必须在 prepareShortTermContext 之前调用——短期上下文用数组下标
// 回指历史消息，先折叠才能保证下标一致。

import type { ChatMessage } from "./chat-storage";
import {
    bigramSetOf,
    diceSimilarityOfSets,
    normalizeForDuplicateCheck,
    NEAR_DUPLICATE_THRESHOLD,
} from "./text-similarity";

export type HistoryDedupeResult = {
    history: ChatMessage[];
    collapsedCount: number;
    /**
     * 只统计最近 RECENT_HINT_WINDOW 条消息内的折叠数——提示词里的"别复读"
     * 指令按它决定是否追加。
     *
     * 为什么要分窗口：重复气泡会永久留在历史里，拿总数当条件的话，
     * 角色早就改好了、提示词却会一直追加一句"你在复读"，那本身又成了
     * 每轮不变的块。窗口内没再复读就不提醒。
     */
    recentCollapsedCount: number;
};

/** 参与折叠的最小归一化长度：短句（"嗯""晚安"）本来就该重复，放行。 */
const MIN_COLLAPSE_LENGTH = 8;

/** 只与最近 N 条保留下来的同说话人文本做近似比较，避免长历史的平方级开销。 */
const NEAR_DUPLICATE_LOOKBACK = 24;

/** "最近还在复读"的观察窗口（消息条数）：窗口外不再提醒。 */
const RECENT_HINT_WINDOW = 30;

/** 可折叠的纯文本 assistant 气泡内容；带媒体/撤回/工具流程的消息不参与折叠。 */
function collapsibleAssistantText(msg: ChatMessage): string | null {
    if (msg.role !== "assistant") return null;
    if (msg.isRetracted) return null;
    if (msg.mediaType || msg.mediaData || msg.mediaUrl) return null;
    const text = (msg.content || "").trim();
    return text || null;
}

/**
 * 折叠历史里重复的 assistant 回复。
 *
 * 同一条内容只保留**最早**的一次：重复项都被去掉后，模型眼前不会停着
 * 一句"我刚说过的话"当续写锚点；内容本身仍在上下文里，信息不丢。
 * 群聊按说话人分组比较——不同角色说同一句话不算复读。
 */
export function collapseRepeatedAssistantMessages(history: ChatMessage[]): HistoryDedupeResult {
    if (history.length < 2) return { history, collapsedCount: 0, recentCollapsedCount: 0 };

    const output: ChatMessage[] = [];
    const exactSeen = new Set<string>();
    const kept: Array<{ sender: string; normalized: string; grams: Set<string> }> = [];
    const recentWindowStart = Math.max(0, history.length - RECENT_HINT_WINDOW);
    let collapsedCount = 0;
    let recentCollapsedCount = 0;

    for (let msgIndex = 0; msgIndex < history.length; msgIndex++) {
        const msg = history[msgIndex];
        const text = collapsibleAssistantText(msg);
        if (text === null) {
            output.push(msg);
            continue;
        }

        const normalized = normalizeForDuplicateCheck(text);
        if (normalized.length < MIN_COLLAPSE_LENGTH) {
            output.push(msg);
            continue;
        }

        const sender = msg.senderName ?? "";
        const exactKey = `${sender}\u0000${normalized}`;
        // 二元组集合只构造一次：同一条候选要与最近 24 条历史逐一比较，
        // 每次比较都重建集合是纯浪费（长历史下这是每轮生成都会付的开销）。
        const grams = bigramSetOf(normalized);
        let isRepeat = exactSeen.has(exactKey);
        if (!isRepeat) {
            for (let i = kept.length - 1; i >= 0 && kept.length - i <= NEAR_DUPLICATE_LOOKBACK; i--) {
                const previous = kept[i];
                if (previous.sender !== sender) continue;
                if (diceSimilarityOfSets(grams, previous.grams) >= NEAR_DUPLICATE_THRESHOLD) {
                    isRepeat = true;
                    break;
                }
            }
        }
        if (isRepeat) {
            collapsedCount++;
            if (msgIndex >= recentWindowStart) recentCollapsedCount++;
            continue;
        }

        exactSeen.add(exactKey);
        kept.push({ sender, normalized, grams });
        output.push(msg);
    }

    if (collapsedCount === 0) return { history, collapsedCount: 0, recentCollapsedCount: 0 };
    return { history: output, collapsedCount, recentCollapsedCount };
}
