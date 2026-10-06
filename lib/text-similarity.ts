// lib/text-similarity.ts
// 复读检测的公共文本工具：归一化 + 字符二元组 Dice 相似度。
//
// 入库守卫（chat-storage 的复读去重）只认"归一化后完全相同"——它丢弃的是真实输出，
// 一字之差都可能是新信息；提示词守卫（prompt-dedupe 的历史折叠）额外抓近似重复，
// 因为折叠只影响模型看到的历史视图、不丢内容。

/** 判定相似度时先剥掉的字符：空白 + 各类中英标点/符号（保留字母、数字、CJK、emoji）。 */
const STRIP_WHITESPACE = /\s+/g;
const STRIP_SYMBOLS = /[,.!?~、，。！？…:：;；'"“”‘’「」『』()（）\[\]{}<>《》【】\-—_·|\\\/+=*&#@$%^`]/g;

/** 近似判定的长度下限：两侧都短于此（"嗯""好的"）就不做相似度计算。
 *  仅约束近似判定——完全相同的短句仍返回 true，是否放行由调用方的长度阈值决定。 */
export const MIN_SIMILARITY_LENGTH = 6;

/** 近似重复阈值（提示词侧）：整段基本同一句话时才算复读。
 *  历史折叠只影响模型看到的历史视图、不丢数据，可以抓得宽一点。 */
export const NEAR_DUPLICATE_THRESHOLD = 0.82;

export function normalizeForDuplicateCheck(text: string): string {
    if (!text) return "";
    return text.replace(STRIP_WHITESPACE, "").replace(STRIP_SYMBOLS, "").toLowerCase();
}

/** 字符二元组集合。文本不变时结果可缓存复用（历史折叠会对同一条文本反复比较）。 */
export function bigramSetOf(normalized: string): Set<string> {
    const grams = new Set<string>();
    for (let i = 0; i + 1 < normalized.length; i++) {
        grams.add(normalized.slice(i, i + 2));
    }
    return grams;
}

/** 两组二元组的 Dice 系数（0-1），供缓存了 bigramSetOf 结果的调用方使用。 */
export function diceSimilarityOfSets(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const gram of a) {
        if (b.has(gram)) overlap++;
    }
    return (2 * overlap) / (a.size + b.size);
}

/** 字符二元组 Dice 系数（0-1）。入参必须已归一化。 */
export function diceSimilarityOfNormalized(normalizedA: string, normalizedB: string): number {
    if (!normalizedA || !normalizedB) return 0;
    if (normalizedA === normalizedB) return 1;
    if (normalizedA.length < 2 || normalizedB.length < 2) return 0;
    return diceSimilarityOfSets(bigramSetOf(normalizedA), bigramSetOf(normalizedB));
}

/** 已归一化文本的近似重复判定（供循环内复用，避免重复归一化）。 */
export function nearDuplicateOfNormalized(
    normalizedA: string,
    normalizedB: string,
    threshold: number = NEAR_DUPLICATE_THRESHOLD,
): boolean {
    if (!normalizedA || !normalizedB) return false;
    if (normalizedA === normalizedB) return true;
    if (Math.min(normalizedA.length, normalizedB.length) < MIN_SIMILARITY_LENGTH) return false;
    return diceSimilarityOfNormalized(normalizedA, normalizedB) >= threshold;
}

/** 原始文本的近似重复判定。 */
export function isNearDuplicateText(
    a: string,
    b: string,
    threshold: number = NEAR_DUPLICATE_THRESHOLD,
): boolean {
    const normalizedA = normalizeForDuplicateCheck(a);
    const normalizedB = normalizeForDuplicateCheck(b);
    return nearDuplicateOfNormalized(normalizedA, normalizedB, threshold);
}
