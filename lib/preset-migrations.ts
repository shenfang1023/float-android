// lib/preset-migrations.ts
// 存量预设的"反重复"修复。
//
// 为什么需要迁移：内置预设一旦被装进本地就成了一份**副本**——改
// lib/builtin-preset.ts 的出厂文本只影响全新安装。老用户的副本里还留着
// "素材优先用日程/今日世界/记忆"这组指令：它把逐轮不变的那几块素材指定成
// 聊天话题来源，模型于是天天讲同一批旧事（用户嘴里的"鬼打墙"）。
// 同时老副本的 frequency_penalty / presence_penalty 都是 0，模型没有任何
// 反重复压力。
//
// 迁移原则（宁可漏改，不可乱改）：
//   1. 只替换与**旧出厂文本逐字一致**的片段——用户自己改过的条目一字不动；
//   2. 采样参数只在"确认这份预设就是出厂副本"（命中过旧出厂文本）且参数仍是
//      旧默认值 0 时才抬——用户自己调过的数字不碰；
//   3. 每份预设带 PRESET_REPETITION_FIX_VERSION 版本号，修过一次就整份跳过：
//      既保证幂等（重复调用不再改动），也不会把用户后来主动删掉的句子又塞回去。

import type { PresetConfig } from "./settings-types";

type PresetTextFix = { from: string; to: string };

/**
 * 旧出厂文本 → 新出厂文本。字符串必须与 lib/builtin-preset.ts 里的运行时
 * 内容逐字一致（那边是数组 join 后的结果，不带转义）。
 */
const TEXT_FIXES: PresetTextFix[] = [
    {
        // 自我表露：原句把"日程/今日世界/记忆"当成表露素材，且没说"讲过就别再讲"
        from: "素材优先用你真实的生活痕迹：本周日程里做过和将做的事、今日世界里和别人的互动、你的记忆与经历；对不上号就按人设合理补全，但要有具体时间地点细节，讲得像个真事。",
        to: "素材优先用你真实的生活痕迹（本周日程、今日世界里的互动、你的记忆与经历）；对不上号就按人设合理补全，但要有具体时间地点细节，讲得像个真事。同一件事只讲一次：已经跟{{user}}讲过的经历、日程和见闻，不要再当新料讲第二遍——要表露就换一件没讲过的，或者就事论事地回应本轮。",
    },
    {
        // 主动分享：补上"分享过的不要重新播报"
        from: "- **主动分享**: 不用等{{user}}问才说自己的事——日程里刚发生或快发生的事、今天遇到的有趣的人和东西、最近的烦恼和心情，都可以像朋友随手分享日常一样自然带出。讲故事可以拆成多条短消息发，不受单条15字的限制。",
        to: "- **主动分享**: 不用等{{user}}问才说自己的事——日程里刚发生或快发生的事、今天遇到的有趣的人和东西、最近的烦恼和心情，都可以像朋友随手分享日常一样自然带出。讲故事可以拆成多条短消息发，不受单条15字的限制。但分享过的内容不要重新播报：已经说过的日常、见闻和心情，不要换个说法再讲一遍。",
    },
    {
        // 反重复规则从"语气/意象"升到"话题/内容"层
        from: "- **No Repetition**: Do not repeat similar response patterns across multiple turns. Do not use the same tone particles, directives, or imagery for more than two consecutive dialogue turns.",
        to: "- **No Repetition**: Do not repeat topics, anecdotes, life details, or response patterns you have already used in previous turns. Anything you have told {{user}} before counts as already said — never re-tell it as if it were new. Do not reuse the same tone particles, directives, or imagery for more than two consecutive dialogue turns. When in doubt, respond to what {{user}} just said instead of volunteering your past material.",
    },
    {
        // 追发提示
        from: "如果继续发消息，内容应该自然，遵循chat_output_format的格式，不要重复之前说过的话。",
        to: "如果继续发消息，内容应该自然，遵循chat_output_format的格式。不要重复之前说过的任何内容——不要重提同一件事、同一段回忆或同一句开场；宁可换个新话题，或者只是关心一句。",
    },
    {
        // 稍后主动联系
        from: "如果发送消息，内容必须自然，遵循chat_output_format的格式，不要机械复述当时的想法。",
        to: "如果发送消息，内容必须自然，遵循chat_output_format的格式，不要机械复述当时的想法，也不要重提你之前已经讲过的事。",
    },
    {
        // 固定时间主动消息 / 冷场重连（出厂文本同句，split/join 一次覆盖两处）
        from: "如果主动发消息，内容要像你自然想起TA后主动开口。可以关心、撒娇、分享近况、轻轻试探、邀请继续聊天，或任何符合你性格的主动开场。",
        to: "如果主动发消息，内容要像你自然想起TA后主动开口。可以关心、撒娇、分享近况、轻轻试探、邀请继续聊天，或任何符合你性格的主动开场。不要重复你之前已经主动说过的事：重开一个话题，或者只关心一句。",
    },
];

/** 旧出厂的采样默认值：两个惩罚都是 0——等于完全没有反重复压力。 */
const LEGACY_SAMPLING_DEFAULTS = { frequency_penalty: 0, presence_penalty: 0 };
/** 新的采样默认值，与 builtin-preset.ts 保持一致。 */
const REPETITION_SAMPLING_DEFAULTS = { frequency_penalty: 0.3, presence_penalty: 0.2 };

/** 迁移版本：升这个值会再为所有预设跑一次新的修复。 */
export const PRESET_REPETITION_FIX_VERSION = 1;

/**
 * 就地把修复应用到传入的预设数组。
 * @returns 是否有任何内容被改动（调用方据此决定是否落库）。
 */
export function applyPresetRepetitionFixes(presets: PresetConfig[]): boolean {
    let changed = false;

    for (const preset of presets) {
        // 已经修过的预设整份跳过：不再扫内容，也就不会把用户后来主动删掉的
        // 那句"同一件事只讲一次"又塞回去
        if ((preset.repetitionFixVersion ?? 0) >= PRESET_REPETITION_FIX_VERSION) continue;
        const prompts = preset.prompts ?? [];
        let matchedLegacyFactoryText = false;

        for (const prompt of prompts) {
            const original = prompt.content;
            if (typeof original !== "string" || !original) continue;
            let content = original;
            for (const fix of TEXT_FIXES) {
                // 幂等护栏：目标文本已在 → 这条修复早就做过了
                if (content.includes(fix.to)) continue;
                if (!content.includes(fix.from)) continue;
                content = content.split(fix.from).join(fix.to);
                matchedLegacyFactoryText = true;
            }
            if (content !== original) {
                prompt.content = content;
                changed = true;
            }
        }

        // 采样参数只在"这份预设确实还是出厂副本"且参数仍是旧默认值时抬升
        if (matchedLegacyFactoryText) {
            if (preset.frequency_penalty === LEGACY_SAMPLING_DEFAULTS.frequency_penalty) {
                preset.frequency_penalty = REPETITION_SAMPLING_DEFAULTS.frequency_penalty;
                changed = true;
            }
            if (preset.presence_penalty === LEGACY_SAMPLING_DEFAULTS.presence_penalty) {
                preset.presence_penalty = REPETITION_SAMPLING_DEFAULTS.presence_penalty;
                changed = true;
            }
        }

        // 打上版本号：这份预设从此不再进入本迁移
        preset.repetitionFixVersion = PRESET_REPETITION_FIX_VERSION;
        changed = true;
    }

    return changed;
}
