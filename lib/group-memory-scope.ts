// 个人长期记忆对群聊的归属边界。
// 在场不等于亲历：只有角色自己说的、别人直接对他说的、或直接发生在他身上的内容，
// 才能进入他的记忆总结。提示词里的近期群聊上下文不受这里影响。
// 名字按花名册消歧：短名字不能命中长名字的内部（「李明」不是「李明远」）。

export type GroupMemoryParty = {
    characterId: string;
    /** 用于点名匹配的名字。单字名只做整段相等匹配，避免从别人的句子里误伤。 */
    names: string[];
};

export type GroupMemoryMessage = {
    id: string;
    role: string;
    content?: string;
    senderCharacterId?: string;
    senderName?: string;
    mediaData?: {
        quoteMessageId?: string;
        quotePreview?: string;
        pokeSender?: string;
        pokeTarget?: string;
        recipientName?: string;
        senderName?: string;
        claimer?: string;
        owner?: string;
        adminActorName?: string;
        adminTargetName?: string;
        label?: string;
        meetingInviteCharacterId?: string;
    };
};

export type GroupMemoryContext = {
    /** 群里除用户外只有这一个角色时，用户的话就是对他说的。 */
    soloCharacterGroup: boolean;
    senderByMessageId: ReadonlyMap<string, { characterId?: string; senderName?: string }>;
    /** 同场其他角色的名字。用来挡住短名误伤，也用来把别人的经历从个人记忆里摘出去。 */
    otherNames?: string[];
};

function cleanNames(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
        const name = raw.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

function equalsName(text: string | undefined, names: string[]): boolean {
    const hay = text?.trim();
    if (!hay) return false;
    return names.some(name => name === hay);
}

function longerNameCovers(hay: string, longer: string, at: number, needleLength: number): boolean {
    const startMin = Math.max(0, at + needleLength - longer.length);
    for (let start = startMin; start <= at; start++) {
        if (hay.startsWith(longer, start)) return true;
    }
    return false;
}

/**
 * `name` 是否在文本里作为独立点名出现。
 * 花名册里更长、且包含这个名字的叫法会盖住同一段字符。
 */
export function textMentionsName(
    text: string | undefined | null,
    name: string,
    blockingNames?: string[],
): boolean {
    const hay = text ?? "";
    const needle = name.trim();
    if (!needle || !hay.trim()) return false;
    if (needle.length < 2) return hay.trim() === needle;
    const blockers = cleanNames(blockingNames ?? []).filter(longer =>
        longer.length > needle.length && longer.includes(needle),
    );
    let from = 0;
    while (from <= hay.length - needle.length) {
        const at = hay.indexOf(needle, from);
        if (at < 0) return false;
        const covered = blockers.some(longer => longerNameCovers(hay, longer, at, needle.length));
        if (!covered) return true;
        from = at + needle.length;
    }
    return false;
}

/** 正文里的点名。两字及以上才做包含匹配，并且会被 otherNames 里的长名字挡住。 */
export function textMentionsCharacter(
    text: string | undefined | null,
    names: string[],
    otherNames?: string[],
): boolean {
    const selfNames = cleanNames(names);
    const blockers = cleanNames([...selfNames, ...(otherNames ?? [])]);
    return selfNames.some(name => textMentionsName(text, name, blockers));
}

function mentionsOther(text: string, selfNames: string[], otherNames: string[]): boolean {
    const blockers = [...selfNames, ...otherNames];
    return otherNames.some(name => textMentionsName(text, name, blockers));
}

function countDistinctOtherMentions(text: string, selfNames: string[], otherNames: string[]): number {
    const blockers = [...selfNames, ...otherNames];
    let count = 0;
    for (const name of otherNames) {
        if (textMentionsName(text, name, blockers)) count++;
    }
    return count;
}

export function buildMemoryRoster(
    characters: { id: string; name: string }[],
    characterId: string,
    fallbackName: string,
): { selfNames: string[]; otherNames: string[] } {
    const selfNames = cleanNames([
        characters.find(character => character.id === characterId)?.name ?? "",
        fallbackName,
    ]);
    const otherNames = cleanNames(
        characters.filter(character => character.id !== characterId).map(character => character.name),
    ).filter(name => !selfNames.includes(name));
    return { selfNames, otherNames };
}

/** 按句号、问号、叹号和换行切开。分隔符留在前一句上。 */
export function splitMemoryClauses(text: string): string[] {
    const parts: string[] = [];
    let buf = "";
    for (const ch of text) {
        buf += ch;
        if ("。！？!?；;\n".includes(ch)) {
            if (buf.trim()) parts.push(buf);
            buf = "";
        }
    }
    if (buf.trim()) parts.push(buf);
    return parts;
}

function quotedMessageIsFromCharacter(
    message: GroupMemoryMessage,
    party: GroupMemoryParty,
    context: GroupMemoryContext,
): boolean {
    const quoteId = message.mediaData?.quoteMessageId;
    if (!quoteId) return false;
    const quoted = context.senderByMessageId.get(quoteId);
    if (!quoted) return false;
    if (quoted.characterId && quoted.characterId === party.characterId) return true;
    return equalsName(quoted.senderName, party.names);
}

function isDirectlyAddressed(
    message: GroupMemoryMessage,
    party: GroupMemoryParty,
    context: GroupMemoryContext,
): boolean {
    const names = party.names;
    if (quotedMessageIsFromCharacter(message, party, context)) return true;
    if (message.mediaData?.meetingInviteCharacterId === party.characterId) return true;
    const addressed = [
        message.mediaData?.pokeTarget,
        message.mediaData?.recipientName,
        message.mediaData?.adminTargetName,
    ];
    return addressed.some(text => equalsName(text, names) || textMentionsCharacter(text, names, context.otherNames));
}

/**
 * 这条群消息算不算「这个角色的亲历」。
 * 多人群里，用户没点名、其他角色在讲自己的事，都返回 false。
 */
export function groupMessageInvolvesCharacter(
    message: GroupMemoryMessage,
    party: GroupMemoryParty,
    context: GroupMemoryContext,
): boolean {
    const names = cleanNames(party.names);
    const scopedParty = { ...party, names };
    if (message.senderCharacterId && message.senderCharacterId === party.characterId) return true;
    if (equalsName(message.senderName, names)) return true;
    if (context.soloCharacterGroup && message.role !== "system") return true;
    if (message.mediaData?.meetingInviteCharacterId === party.characterId) return true;
    if (quotedMessageIsFromCharacter(message, scopedParty, context)) return true;

    const addressed = [
        message.content,
        message.mediaData?.quotePreview,
        message.mediaData?.pokeSender,
        message.mediaData?.pokeTarget,
        message.mediaData?.recipientName,
        message.mediaData?.senderName,
        message.mediaData?.claimer,
        message.mediaData?.owner,
        message.mediaData?.adminActorName,
        message.mediaData?.adminTargetName,
        message.mediaData?.label,
    ];
    return addressed.some(text => textMentionsCharacter(text, names, context.otherNames));
}

type ClauseSticky = "self" | "other";

/**
 * 从一段别人的话里留下和这个角色有关的句子。
 * 点到本人之后，紧跟着的、没有其他角色名字的句子也留下（「我觉得可以」这种续话）。
 * 一旦句子只点了别人，续话就断开。
 */
export function excerptWitnessedText(
    text: string,
    selfNames: string[],
    otherNames: string[],
    initial: ClauseSticky,
): string {
    const self = cleanNames(selfNames);
    const others = cleanNames(otherNames).filter(name => !self.includes(name));
    let sticky: ClauseSticky = initial;
    const kept: string[] = [];
    for (const clause of splitMemoryClauses(text)) {
        const selfHit = textMentionsCharacter(clause, self, others);
        const otherHit = mentionsOther(clause, self, others);
        if (selfHit) {
            kept.push(clause);
            sticky = "self";
            continue;
        }
        if (otherHit) {
            sticky = "other";
            continue;
        }
        if (sticky === "self") kept.push(clause);
    }
    return kept.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 多人共用的摘要（剧情、跑团、线下群聊、访谈）只留明确点到本人的句子。
 * 没有点名的句子不跟着上一个人走，避免把别人的经历接进这条记忆。
 */
export function excerptSharedPersonalMemory(
    text: string,
    selfNames: string[],
    otherNames: string[],
): string | null {
    const self = cleanNames(selfNames);
    const others = cleanNames(otherNames).filter(name => !self.includes(name));
    const kept = splitMemoryClauses(text).filter(clause => textMentionsCharacter(clause, self, others));
    const excerpt = kept.join("").replace(/\n{3,}/g, "\n\n").trim();
    return excerpt || null;
}

/**
 * 总结正文：删掉只属于其他角色的句子，留下本人参与的句子，以及没有点名的用户事实。
 */
export function retainPersonalMemoryProse(
    text: string,
    selfNames: string[],
    otherNames: string[],
): string {
    const self = cleanNames(selfNames);
    const others = cleanNames(otherNames).filter(name => !self.includes(name));
    const kept = splitMemoryClauses(text).filter(clause => {
        if (textMentionsCharacter(clause, self, others)) return true;
        return !mentionsOther(clause, self, others);
    });
    return kept.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** 整段只在讲别的角色，没有这个角色，也不是没点名的用户事实。 */
export function isForeignMemoryText(
    text: string,
    selfNames: string[],
    otherNames: string[],
): boolean {
    const self = cleanNames(selfNames);
    const others = cleanNames(otherNames).filter(name => !self.includes(name));
    if (textMentionsCharacter(text, self, others)) return false;
    return mentionsOther(text, self, others);
}

/**
 * 把一条已经判定为「与这个角色有关」的群消息收成他的亲历文本。
 * 本人的正常发言整段保留；一条里点了两个以上其他角色时，视为把整场戏错挂到他头上，只留他本人的句子。
 * 别人的发言只留点到他的句子和紧跟的续话。
 */
export function scopeGroupTextForPersonalMemory(
    text: string,
    message: GroupMemoryMessage,
    party: GroupMemoryParty,
    context: GroupMemoryContext,
): string {
    const body = text.trim();
    if (!body) return "";
    const selfNames = cleanNames(party.names);
    const otherNames = cleanNames(context.otherNames ?? []).filter(name => !selfNames.includes(name));
    if (context.soloCharacterGroup || otherNames.length === 0) return body;
    const own = (message.senderCharacterId && message.senderCharacterId === party.characterId)
        || equalsName(message.senderName, selfNames);
    const distinctOthers = countDistinctOtherMentions(body, selfNames, otherNames);
    if (own && distinctOthers < 2) return body;
    const initial: ClauseSticky = own || isDirectlyAddressed(message, { ...party, names: selfNames }, context)
        ? "self"
        : "other";
    // 错挂的整场戏不能从「这是他的消息」开始就把别人的句子留下来。
    const sceneDump = own && distinctOthers >= 2;
    return excerptWitnessedText(body, selfNames, otherNames, sceneDump ? "other" : initial);
}
