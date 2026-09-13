/**
 * Minimal 5-field cron support (minute hour day-of-month month day-of-week), UTC only.
 * Supported syntax per field: wildcard, single value, range, list, step, and range step.
 */
type CronField = { name: string; min: number; max: number };

const FIELDS: CronField[] = [
  { name: "Menit", min: 0, max: 59 },
  { name: "Jam", min: 0, max: 23 },
  { name: "Tanggal", min: 1, max: 31 },
  { name: "Bulan", min: 1, max: 12 },
  { name: "Hari", min: 0, max: 7 },
];

const DOW_INDEX = 4; // day-of-week field position, 0 and 7 both mean Sunday.
const MAX_MINUTES = 366 * 24 * 60; // search horizon for nextCronRun.

const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const MONTH_NAMES = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

export type CronSpec = { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; dow: Set<number> };
type ParseResult = { ok: true; spec: CronSpec } | { ok: false; error: string };
type FieldResult = { ok: true; values: Set<number> } | { ok: false; error: string };

/** Sunday is accepted as 0 or 7; everything is stored as 0-6. */
function normalizeDayOfWeek(value: number, index: number): number {
  return index === DOW_INDEX && value === 7 ? 0 : value;
}

function parseField(raw: string, field: CronField, index: number): FieldResult {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") return { ok: false, error: `${field.name} tidak boleh kosong` };

    const segments = token.split("/");
    if (segments.length > 2) return { ok: false, error: `${field.name} tidak valid: ${token}` };
    const base = segments[0] ?? "";
    const stepText = segments[1];

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return { ok: false, error: `Langkah ${field.name} harus angka` };
      step = Number(stepText);
      const span = field.max - field.min + 1;
      if (step < 1 || step > span) return { ok: false, error: `Langkah ${field.name} harus 1-${span}` };
    }

    let start: number;
    let end: number;
    if (base === "*") {
      start = field.min;
      end = field.max;
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2) return { ok: false, error: `${field.name} tidak valid: ${token}` };
      const [fromText, toText] = bounds as [string, string];
      if (!/^\d+$/.test(fromText) || !/^\d+$/.test(toText)) return { ok: false, error: `${field.name} tidak valid: ${token}` };
      start = Number(fromText);
      end = Number(toText);
      if (start > end) return { ok: false, error: `Rentang ${field.name} terbalik: ${token}` };
    } else {
      if (!/^\d+$/.test(base)) return { ok: false, error: `${field.name} tidak valid: ${token}` };
      start = Number(base);
      end = stepText === undefined ? start : field.max;
    }

    if (start < field.min || end > field.max) {
      return { ok: false, error: `${field.name} harus ${field.min}-${field.max}` };
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeDayOfWeek(value, index));
    }
  }
  if (values.size === 0) return { ok: false, error: `${field.name} tidak memiliki nilai` };
  return { ok: true, values };
}

function parseCron(expr: string): ParseResult {
  const trimmed = (expr ?? "").trim();
  if (trimmed === "") return { ok: false, error: "Ekspresi cron tidak boleh kosong" };
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: "Ekspresi cron harus 5 bagian" };

  const sets: Set<number>[] = [];
  for (let index = 0; index < FIELDS.length; index += 1) {
    const field = FIELDS[index] as CronField;
    const result = parseField(parts[index] ?? "", field, index);
    if (!result.ok) return { ok: false, error: result.error };
    sets.push(result.values);
  }
  return {
    ok: true,
    spec: {
      minute: sets[0] as Set<number>,
      hour: sets[1] as Set<number>,
      day: sets[2] as Set<number>,
      month: sets[3] as Set<number>,
      dow: sets[4] as Set<number>,
    },
  };
}

/** Validates a 5-field cron expression and returns a short Indonesian error message. */
export function validateCronExpression(expr: string): { ok: true } | { ok: false; error: string } {
  const parsed = parseCron(expr);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}

/** First matching minute strictly after `from`, as an ISO UTC string, or null when invalid. */
export function nextCronRun(expr: string, from: Date): string | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return null;
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null;

  const { minute, hour, day, month, dow } = parsed.spec;
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let step = 0; step < MAX_MINUTES; step += 1) {
    const matched =
      minute.has(cursor.getUTCMinutes()) &&
      hour.has(cursor.getUTCHours()) &&
      month.has(cursor.getUTCMonth() + 1) &&
      day.has(cursor.getUTCDate()) &&
      dow.has(cursor.getUTCDay());
    if (matched) return cursor.toISOString();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function isWildcard(values: Set<number>, index: number): boolean {
  const field = FIELDS[index] as CronField;
  if (index === DOW_INDEX) return values.size === 7;
  return values.size === field.max - field.min + 1;
}

function single(values: Set<number>): number | null {
  if (values.size !== 1) return null;
  for (const value of values) return value;
  return null;
}

/** Short Indonesian description for common patterns; complex ones fall back to a generic text. */
export function describeCron(expr: string): string {
  const parsed = parseCron(expr);
  if (!parsed.ok) return parsed.error;

  const { minute, hour, day, month, dow } = parsed.spec;
  const parts = expr.trim().split(/\s+/);
  const minuteStep = /^\*\/(\d+)$/.exec(parts[0] ?? "");
  const hourStep = /^\*\/(\d+)$/.exec(parts[1] ?? "");
  const minuteWild = isWildcard(minute, 0);
  const hourWild = isWildcard(hour, 1);
  const dayWild = isWildcard(day, 2);
  const monthWild = isWildcard(month, 3);
  const dowWild = isWildcard(dow, DOW_INDEX);

  if (minuteWild && hourWild && dayWild && monthWild && dowWild) return "Setiap menit";
  if (minuteStep && hourWild && dayWild && monthWild && dowWild) return `Setiap ${minuteStep[1]} menit`;

  const m = single(minute);
  const h = single(hour);

  if (hourStep && m !== null && dayWild && monthWild && dowWild) return `Setiap ${hourStep[1]} jam pada menit ${pad2(m)}`;
  if (minuteWild && h !== null && dayWild && monthWild && dowWild) return `Setiap menit pada jam ${pad2(h)}`;
  if (m === null || h === null) return "Sesuai jadwal khusus";

  const time = `pukul ${pad2(h)}:${pad2(m)}`;
  const monthName = single(month);
  const monthSuffix = !monthWild && monthName !== null ? ` pada bulan ${MONTH_NAMES[monthName] ?? monthName}` : "";

  if (dayWild && dowWild) {
    if (monthWild || monthName !== null) return `Setiap hari ${time}${monthSuffix}`;
    return "Sesuai jadwal khusus";
  }

  if (dowWild) {
    const dayOfMonth = single(day);
    if (dayOfMonth === null) return "Sesuai jadwal khusus";
    return `Setiap tanggal ${dayOfMonth} ${time}${monthSuffix}`;
  }

  if (dayWild) {
    const names = [...dow].sort((a, b) => a - b).map((index) => DAY_NAMES[index] ?? `hari ${index}`);
    if (names.length === 0) return "Sesuai jadwal khusus";
    return `Setiap ${names.join(", ")} ${time}${monthSuffix}`;
  }

  return "Sesuai jadwal khusus";
}
