export type CharacterTimeContext = {
  systemTime: string;
  systemWeekday: string;
  systemTimeZone: string;
  characterTime: string;
  characterWeekday: string;
  characterTimeZone: string;
  timeContext: string;
  hasDifference: boolean;
};

export type GroupTimeMember = {
  name: string;
  timeZone?: string | null;
};

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

type DateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getSystemTimeZone(): string {
  return readTimeZone();
}

export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeZone = value.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    hour12: false,
  });
  const values: Partial<DateParts> = {};
  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year"
      || part.type === "month"
      || part.type === "day"
      || part.type === "hour"
      || part.type === "minute"
      || part.type === "second"
    ) {
      values[part.type] = part.value;
    }
  }
  const parts: DateParts = {
    year: values.year || "0000",
    month: values.month || "01",
    day: values.day || "01",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00",
  };
  // Some engines report midnight as hour 24 on the previous civil date.
  if (parts.hour !== "24") return parts;
  const rolled = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  rolled.setUTCDate(rolled.getUTCDate() + 1);
  return {
    ...parts,
    year: String(rolled.getUTCFullYear()),
    month: String(rolled.getUTCMonth() + 1).padStart(2, "0"),
    day: String(rolled.getUTCDate()).padStart(2, "0"),
    hour: "00",
  };
}

export type ZonedClock = {
  timeZone: string;
  dateIso: string;
  minutes: number;
  weekStartIso: string;
  /** HH:MM in the zone */
  label: string;
};

/** Monday-start civil week of a YYYY-MM-DD. Independent of the phone timezone. */
export function weekStartFromIsoDate(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return iso;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const day = utc.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  utc.setUTCDate(utc.getUTCDate() + diff);
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const date = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

/** Wall clock in `timeZone`. Empty or invalid zones follow the phone. */
export function getZonedClock(timeZone: string | null | undefined, now = new Date()): ZonedClock {
  const zone = normalizeTimeZone(timeZone) || getSystemTimeZone();
  const parts = getDateParts(now, zone);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const dateIso = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    timeZone: zone,
    dateIso,
    minutes: hour * 60 + minute,
    weekStartIso: weekStartFromIsoDate(dateIso),
    label: `${String(hour).padStart(2, "0")}:${parts.minute}`,
  };
}

/**
 * Epoch of a civil YYYY-MM-DD plus minutes-from-midnight in `timeZone`.
 * Do not use Date#setHours for this — that writes the phone's wall clock.
 */
export function zonedDateTimeToEpoch(dateIso: string, minutes: number, timeZone: string): number {
  const zone = normalizeTimeZone(timeZone) || getSystemTimeZone();
  const match = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !Number.isFinite(minutes)) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Math.min(23, Math.max(0, Math.floor(minutes / 60)));
  const minute = Math.min(59, Math.max(0, minutes % 60));
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wanted;
  for (let i = 0; i < 4; i++) {
    const parts = getDateParts(new Date(guess), zone);
    const got = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      0,
    );
    const delta = wanted - got;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

/** Short city for a zone that differs from the phone. Empty when it follows the phone. */
export function timeZoneCityLabel(timeZone: string | null | undefined): string {
  const named = normalizeTimeZone(timeZone);
  if (!named || named === getSystemTimeZone()) return "";
  return named.split("/").pop()?.replace(/_/g, " ") || named;
}

/** Locks schedule HH:MM to the character zone (or the phone zone when none is set). */
export function formatScheduleClockRule(timeZone: string | null | undefined, now = new Date()): string {
  const named = normalizeTimeZone(timeZone);
  const clock = getZonedClock(named, now);
  if (!named || named === getSystemTimeZone()) {
    return `时间基准：${clock.timeZone}，当地现在是 ${clock.dateIso} ${clock.label}。日程里的日期和 HH:MM 按这个时区书写，不要另换成别的时区。`;
  }
  return `时间基准：角色时区 ${named}，按这个时区的钟点书写，不要改成手机时区 ${getSystemTimeZone()}。角色当地现在是 ${clock.dateIso} ${clock.label}。日程里的日期和 HH:MM 必须是 ${named} 的本地钟点。`;
}

export function formatZonedPromptTimestamp(date: Date, timeZone: string, includeTimeZone = false): string {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${includeTimeZone ? ` ${timeZone}` : ""}`;
}

export function formatZonedChineseDateTime(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  return `${Number(parts.year)}年${Number(parts.month)}月${Number(parts.day)}日${parts.hour}:${parts.minute}`;
}

export function getZonedWeekday(date: Date, timeZone: string): string {
  try {
    const label = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
    return label || WEEKDAYS[0];
  } catch {
    return WEEKDAYS[date.getDay()];
  }
}

// ── 公历节日感知 ──────────────────────────────
// 农历节日（春节/七夕/中秋）随年份漂移 ±3 周，无农历表宁可不注也别注错。
const FIXED_HOLIDAYS: Record<string, string> = {
  "01-01": "元旦", "02-14": "情人节", "03-08": "妇女节", "03-14": "白色情人节",
  "04-01": "愚人节", "05-01": "劳动节", "05-04": "青年节", "06-01": "儿童节",
  "09-10": "教师节", "10-01": "国庆节", "10-31": "万圣夜", "11-01": "万圣节",
  "11-11": "光棍节", "12-24": "平安夜", "12-25": "圣诞节", "12-31": "跨年夜",
};

/** 第 nth 个 weekday（0=周日）落在某月的几号；nth 传 -1 表示最后一个。 */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  if (nth === -1) {
    const last = new Date(year, month + 1, 0).getDate();
    for (let d = last; d > last - 7; d--) {
      if (new Date(year, month, d).getDay() === weekday) return d;
    }
    return last;
  }
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const day = new Date(year, month, d);
    if (day.getMonth() !== month) break;
    if (day.getDay() === weekday && ++count === nth) return d;
  }
  return -1;
}

/** 今天是几月几号 → 节日名；不是节日返回空串。按传入时区的本地日期算。 */
export function resolveHolidayName(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  const mm = parts.month, dd = parts.day;
  const fixed = FIXED_HOLIDAYS[`${mm}-${dd}`];
  if (fixed) return fixed;
  const y = Number(parts.year), m = Number(mm), d = Number(dd);
  if (m === 5 && d === nthWeekdayOfMonth(y, 4, 0, 2)) return "母亲节";
  if (m === 6 && d === nthWeekdayOfMonth(y, 5, 0, 3)) return "父亲节";
  if (m === 11 && d === nthWeekdayOfMonth(y, 10, 4, 4)) return "感恩节";
  return "";
}

export function hasTimeZoneDifference(date: Date, characterTimeZone: string, systemTimeZone = getSystemTimeZone()): boolean {
  const systemParts = getDateParts(date, systemTimeZone);
  const characterParts = getDateParts(date, characterTimeZone);
  return systemParts.year !== characterParts.year
    || systemParts.month !== characterParts.month
    || systemParts.day !== characterParts.day
    || systemParts.hour !== characterParts.hour
    || systemParts.minute !== characterParts.minute;
}

export function buildCharacterTimeContext(timeZone?: string | null, now = new Date()): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const hasDifference = normalizedTimeZone ? hasTimeZoneDifference(now, normalizedTimeZone, systemTimeZone) : false;

  if (!normalizedTimeZone || !hasDifference) {
    const holiday = resolveHolidayName(now, systemTimeZone);
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `当前系统时间：${systemTime}，${systemWeekday}${holiday ? `，今天是${holiday}` : ""}`,
      hasDifference: false,
    };
  }

  const characterTime = formatZonedChineseDateTime(now, normalizedTimeZone);
  const characterWeekday = getZonedWeekday(now, normalizedTimeZone);
  const holiday = resolveHolidayName(now, normalizedTimeZone);
  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime,
    characterWeekday,
    characterTimeZone: normalizedTimeZone,
    timeContext: [
      `当前系统时间：${systemTime} ${systemTimeZone}，${systemWeekday}`,
      `角色本地时间：${characterTime} ${normalizedTimeZone}，${characterWeekday}${holiday ? `，今天是${holiday}` : ""}`,
      "判断角色作息、问候、深夜/清晨/工作时间时，优先使用角色本地时间。",
    ].join("\n"),
    hasDifference: true,
  };
}

export function buildGroupTimeContext(members: GroupTimeMember[], now = new Date()): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const systemHoliday = resolveHolidayName(now, systemTimeZone);
  const rows = members
    .map(member => {
      const timeZone = normalizeTimeZone(member.timeZone);
      if (!timeZone || !hasTimeZoneDifference(now, timeZone, systemTimeZone)) return null;
      const memberHoliday = resolveHolidayName(now, timeZone);
      return `${member.name}：${formatZonedChineseDateTime(now, timeZone)} ${timeZone}，${getZonedWeekday(now, timeZone)}${memberHoliday ? `（${memberHoliday}）` : ""}`;
    })
    .filter((row): row is string => Boolean(row));

  if (rows.length === 0) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `当前系统时间：${systemTime}，${systemWeekday}${systemHoliday ? `，今天是${systemHoliday}` : ""}`,
      hasDifference: false,
    };
  }

  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime: "",
    characterWeekday: "",
    characterTimeZone: "",
    timeContext: [
      `当前系统时间：${systemTime} ${systemTimeZone}，${systemWeekday}${systemHoliday ? `，今天是${systemHoliday}` : ""}`,
      "群成员本地时间：",
      ...rows,
      "判断每个角色作息、问候、深夜/清晨/工作时间时，优先使用该角色自己的本地时间。",
    ].join("\n"),
    hasDifference: true,
  };
}
