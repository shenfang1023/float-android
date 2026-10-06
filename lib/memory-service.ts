// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { effectiveSalience, memoryKindOf, type MemorySurfacedRecord } from "./memory-types";
import { loadMemoryEntriesByType, loadMemorySurfacedRecords, markMemorySurfaced } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 *
 * 永远是**四维打分**，没有"总量没超预算就整包返回"的捷径——那条捷径正是
 * "每天都重复说同样的话"的元凶：预算默认 100000 时它恒成立，相关性排序全部
 * 作废，同一个角色每轮拿到的记忆一字不差。
 *
 *   score = (recency·新近 + salience·重要性 + relevance·相关性 + novelty·新鲜度) × kindBonus
 *
 * - recency   半衰期 ~7 天：越久远的经历越淡
 * - salience  LLM 评的重要性；reflection/trait_shift 是高层记忆，轻微加成
 * - relevance 与本轮上下文（世界书命中/最近对话）的 embedding 余弦
 * - novelty   刚讲过、反复讲过的降权 → 同一批陈年旧事不会天天霸榜
 *
 * Embedding API 取自辅助绑定（全局，非按角色）；没有向量时 relevance 的权重
 * 摊给其余三维，打分照常进行。
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig,
    options?: { trackSurfacing?: boolean },
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;
    const nowMs = Date.now();

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const queryEmbedding = embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)
        ? await generateEmbedding(currentContext, embeddingApiConfig)
        : null;

    // 有向量的条目用四维；没向量的条目（当时没开向量召回、或 embedding 生成失败）
    // 用剩下三维**重新归一化**——否则它会白丢 relevance 的权重，被"有向量但毫不
    // 相关"的邻居反超，于是重要却冷门的记忆永远挤不进上下文。
    const fourDimWeights = { recency: 0.25, salience: 0.2, relevance: 0.35, novelty: 0.2 };
    const threeDimWeights = { recency: 0.4, salience: 0.25, relevance: 0, novelty: 0.35 };
    const surfacedRecords = loadMemorySurfacedRecords(longTermEntries.map(entry => entry.id));

    const scored = longTermEntries.map(entry => {
        const entryEmbedding = queryEmbedding && entry.embedding?.length ? entry.embedding : null;
        const weights = entryEmbedding ? fourDimWeights : threeDimWeights;
        const relevance = entryEmbedding && queryEmbedding
            ? Math.max(0, cosineSimilarity(queryEmbedding, entryEmbedding))
            : 0;
        const score = (
            weights.recency * recencyScoreOf(entry, nowMs)
            + weights.salience * salienceScoreOf(entry)
            + weights.relevance * relevance
            + weights.novelty * noveltyScoreOf(surfacedRecords.get(entry.id), nowMs)
        ) * kindBonusOf(entry);
        return { entry, score };
    });
    scored.sort((a, b) => b.score - a.score || a.entry.createdAt.localeCompare(b.entry.createdAt));

    const selected = fillByBudget(scored.map(item => item.entry), budget);
    // 输出按时间正序：读起来仍是一段有先后的经历，而不是按分数乱排的清单
    selected.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // 记账：本轮真正进了提示词 → 下一轮新鲜度自然下降。同步写 kv 缓存，不阻塞生成。
    // trackSurfacing=false 给"记忆不是喂给模型、而是交给自定义 APP 当数据"的读用——
    // 那种读取没往任何提示词里塞东西，不该让召回权重偏移。
    // （核心记忆按关系事实稳定注入、不参与轮换，所以不记账。）
    if (options?.trackSurfacing !== false) {
        markMemorySurfaced(selected.map(entry => entry.id), new Date(nowMs).toISOString());
    }

    return selected;
}

function recencyScoreOf(entry: MemoryEntry, nowMs: number): number {
    const ageDays = Math.max(0, (nowMs - new Date(entry.createdAt).getTime()) / 86400000);
    return Math.exp(-ageDays / 7);
}

function salienceScoreOf(entry: MemoryEntry): number {
    return effectiveSalience(entry) / 10;
}

function kindBonusOf(entry: MemoryEntry): number {
    const kind = memoryKindOf(entry);
    return kind === "reflection" || kind === "trait_shift" ? 1.1 : 1.0;
}

/**
 * 新鲜度：刚讲过、反复讲过的记忆降权，从未提起的给满分。
 * 半衰期 ~1.4 天 + 计数惩罚——这是让"同一批记忆天天霸榜"自己散开的机关。
 */
function noveltyScoreOf(record: MemorySurfacedRecord | undefined, nowMs: number): number {
    if (!record || !record.at) return 1;
    const lastMs = Date.parse(record.at);
    if (!Number.isFinite(lastMs)) return 1;
    const ageDays = Math.max(0, (nowMs - lastMs) / 86400000);
    return Math.exp(-ageDays / 2) / (1 + 0.5 * record.count);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/**
 * 按顺序挑条目直到预算用尽。
 *
 * 用 continue 而不是 break：条目是按分数排序的，某一条超预算不能把后面所有
 * 更小的条目一起丢——预算调小（最低 200 token）时 break 会让整块长期记忆变空。
 */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) continue;
        result.push(entry);
        used += tokens;
    }
    return result;
}
