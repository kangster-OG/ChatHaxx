export interface ModelUsage {
  model: string;
  /**
   * `codex`: a window from ChatGPT's `wham/usage`, which is Codex's usage (the 5-hour and weekly
   * limits Codex's /status and ChatGPT's sidebar show), never a limit on ChatGPT chat messages.
   */
  scope: 'model' | 'feature' | 'codex';
  remaining: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  windowSeconds: number | null;
  observedAt: number;
}
export interface UsageModelTokens {
  model: string;
  reasoningEffort: string | null;
  /** Legacy rows with no recorded model use GPT-5.6 High, visibly marked as assumed. */
  assumed: boolean;
  /** Every part below added together. */
  tokens: number;
  parts: UsageTokenParts;
}
/**
 * One model's estimated round trips, split the way the API bills them: new input, input the
 * provider can serve from its prompt cache (the prefix the previous round trip already sent),
 * and visible output. `long*` parts belong to round trips whose input passed
 * LONG_CONTEXT_TOKENS, which the API bills at its long-context rates. Hidden reasoning is not
 * visible on the page, so it is not here; the formula's multiplier stands in for it.
 */
export interface UsageTokenParts { input: number; cached: number; output: number; longInput: number; longCached: number; longOutput: number }
export const USAGE_PART_KEYS = ['input', 'cached', 'output', 'longInput', 'longCached', 'longOutput'] as const satisfies ReadonlyArray<keyof UsageTokenParts>;
export function emptyUsageParts(): UsageTokenParts { return { input: 0, cached: 0, output: 0, longInput: 0, longCached: 0, longOutput: 0 }; }
export function addUsageParts(target: UsageTokenParts, add: Readonly<UsageTokenParts>): UsageTokenParts {
  for (const key of USAGE_PART_KEYS) target[key] += add[key];
  return target;
}
export function usagePartsTotal(parts: Readonly<UsageTokenParts>): number {
  return USAGE_PART_KEYS.reduce((sum, key) => sum + parts[key], 0);
}
export interface UsageOverview {
  /** Account-wide comparison ceiling selected from the observed model catalog. */
  contextTokenCap: number;
  /** Verified native sends, independently of token estimates or provider quotas. */
  messages: { through: number; days: UsageMessageDay[] };
  limits: ModelUsage[];
  days: Array<{ date: string; tokens: number; models: UsageModelTokens[] }>;
  models: UsageModelTokens[];
  /** The same totals grouped by each chat's current project, largest first. */
  projects: UsageProjectTokens[];
  tokens: number;
  sessions: number;
}
/** `projectId: null` holds the chats outside every project. */
export interface UsageProjectTokens { projectId: string | null; tokens: number; models: UsageModelTokens[] }

export interface UsageMessageDay { date: string; gpt56: number; gpt6: number }
export type UsageMessageFamily = 'gpt-5.6' | 'gpt-6';

/**
 * Explicit recorded version identities only; unknown suffixes remain unclassified. ChatGPT records its
 * Instant and Thinking lanes as `gpt-6` and `gpt-6-thinking` (`gpt-5-6-instant`, `gpt-5-6-thinking`
 * for 5.6), observed 2026-10-07; each lane counts toward its generation. GPT-6's Instant (`gpt-6`) is
 * ChatGPT's automatic lane and may be answered by `gpt-6-thinking`; both count as GPT-6.
 */
export function usageMessageFamily(model: string | undefined): UsageMessageFamily | null {
  const id = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (/^(?:gpt-?)?5[.-]6(?:-(?:instant|thinking|pro|sol|terra|luna))?$/.test(id) || id === 'sol') return 'gpt-5.6';
  if (/^(?:gpt-?)?6(?:\.0)?(?:-(?:instant|thinking|pro|astra))?$/.test(id) || id === 'astra') return 'gpt-6';
  return null;
}

export function usageDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Most recent selected weekday at local midnight, including today. Calendar days preserve DST. */
export function usageWeekStart(weekday: number, through: number): number {
  const date = new Date(through);
  date.setDate(date.getDate() - (date.getDay() - weekday + 7) % 7);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function usageMessageTotals(messages: UsageOverview['messages'], weekday: number): UsageMessageDay {
  const from = usageDateKey(new Date(usageWeekStart(weekday, messages.through)));
  const through = usageDateKey(new Date(messages.through));
  return messages.days.reduce((total, day) => day.date >= from && day.date <= through
    ? { ...total, gpt56: total.gpt56 + day.gpt56, gpt6: total.gpt6 + day.gpt6 } : total,
  { date: from, gpt56: 0, gpt6: 0 });
}
/** USD per million tokens, as the API's price list states them for its standard tier. */
export interface UsageRate { input: number; cached: number; output: number }
export interface UsageFormula {
  /** Stands in for hidden reasoning and request overhead the page cannot see. */
  multiplier: number;
  rates: Record<string, UsageRate | null>;
}
/** The API bills a request whose input passes this at its long-context rates. */
export const LONG_CONTEXT_TOKENS = 272_000;
/** Long-context rates are twice the input and cached-input rates and 1.5 times the output rate. */
export const LONG_CONTEXT_INPUT_FACTOR = 2;
export const LONG_CONTEXT_OUTPUT_FACTOR = 1.5;
export const USAGE_RATES_CHECKED = '2026-10-26';
// Standard-tier API rates from https://developers.openai.com/api/docs/pricing, checked 26 October
// 2026. GPT-6 Pro is ChatGPT's Astra label. GPT-5.5 Pro has no cached-input rate, so its cached
// input costs the full input rate. Sources are in usage-model-attribution.md.
export const DEFAULT_USAGE_FORMULA: UsageFormula = {
  multiplier: 1.2,
  rates: {
    'gpt-6-astra': { input: 10, cached: 1, output: 50 },
    'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
    'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
    'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
    'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
    'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
    'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
    'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
    'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
    'gpt-5.5-pro': { input: 30, cached: 30, output: 180 }
  }
};
// Exact historical/provider identities only. This is a reporting projection, not
// account availability or browser selection authority. Effort remains independent.
const usageAliases: Readonly<Record<string, string>> = {
  '5.6': 'gpt-5.6-sol', 'gpt-5.6': 'gpt-5.6-sol', 'gpt-5-6': 'gpt-5.6-sol',
  'gpt-5-6-instant': 'gpt-5.6-sol', 'gpt-5-6-thinking': 'gpt-5.6-sol', 'gpt-5-6-pro': 'gpt-5.5-pro',
  '6': 'gpt-6-astra', 'gpt-6-pro': 'gpt-6-astra',
  // ChatGPT's GPT-6 Instant and Thinking lanes have no published API identity; GPT-6 Sol is the
  // closest priced model. GPT-5.6 Pro has none either; GPT-5.5 Pro is the only priced 5.x Pro.
  'gpt-6': 'gpt-6-sol', 'gpt-6-thinking': 'gpt-6-sol', 'gpt-6-instant': 'gpt-6-sol',
  // ChatGPT labels these "5.5"; the API has one GPT-5.5 model with a cached-input rate.
  '5.5': 'gpt-5.5', 'gpt-5-5': 'gpt-5.5', 'gpt-5-5-instant': 'gpt-5.5', 'gpt-5-5-thinking': 'gpt-5.5'
};
export function usageModel(model: string): string { return Object.hasOwn(usageAliases, model) ? usageAliases[model]! : model; }
/** Group the display while retaining each raw source for its exact manual rate. */
export function usageModelGroups(rows: readonly UsageModelTokens[]): Array<{ model: string; reasoningEffort: string | null; assumed: boolean; sources: UsageModelTokens[] }> {
  const groups = new Map<string, { model: string; reasoningEffort: string | null; assumed: boolean; sources: UsageModelTokens[] }>();
  for (const row of rows) {
    const identity = { model: usageModel(row.model), reasoningEffort: row.reasoningEffort, assumed: row.assumed };
    const key = usageModelKey(identity);
    const group = groups.get(key) ?? { ...identity, sources: [] };
    group.sources.push(row); groups.set(key, group);
  }
  return [...groups.values()];
}
/** Explicit per-recorded-ID rates, including zero/null, override equivalent-model defaults. */
export function usageRate(model: string, formula: UsageFormula): UsageRate | null | undefined {
  if (Object.hasOwn(formula.rates, model)) return formula.rates[model];
  const canonical = usageModel(model);
  return Object.hasOwn(formula.rates, canonical) ? formula.rates[canonical] : undefined;
}
export function usageModelKey(row: Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>): string {
  return JSON.stringify([row.model, row.reasoningEffort, row.assumed]);
}
export function validUsageRate(rate: unknown): rate is UsageRate {
  return Boolean(rate) && typeof rate === 'object' && (['input', 'cached', 'output'] as const)
    .every(key => typeof (rate as UsageRate)[key] === 'number' && Number.isFinite((rate as UsageRate)[key]) && (rate as UsageRate)[key] >= 0);
}
/** The cache stores token parts; formula edits are a cheap projection, never a transcript reread. */
export function usageEstimate(rows: readonly UsageModelTokens[], formula: UsageFormula): { tokens: number; cost: number; unpricedTokens: number } {
  let tokens = 0, cost = 0, unpricedTokens = 0;
  for (const row of rows) {
    tokens += row.tokens;
    const rate = usageRate(row.model, formula);
    if (!validUsageRate(rate)) { unpricedTokens += row.tokens; continue; }
    const { parts } = row;
    const dollars = parts.input * rate.input + parts.cached * rate.cached + parts.output * rate.output
      + (parts.longInput * rate.input + parts.longCached * rate.cached) * LONG_CONTEXT_INPUT_FACTOR
      + parts.longOutput * rate.output * LONG_CONTEXT_OUTPUT_FACTOR;
    cost += dollars / 1e6 * formula.multiplier;
  }
  return { tokens, cost, unpricedTokens };
}

/** A local time as `YYYY-MM-DD HH:MM`, which spreadsheets read as a date and time. */
function usageCsvTime(time: number): string {
  const date = new Date(time);
  return `${usageDateKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** RFC 4180 quoting; a text cell that a spreadsheet would run as a formula starts with `'`. */
function usageCsvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = typeof value === 'number' ? String(value) : /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
/**
 * The Usage page as a CSV file: estimated tokens per day with the verified sends of the last
 * seven days beside them, then the latest limit reading. English column names keep the file
 * readable by scripts; it holds no path, chat, account or conversation id.
 */
export function usageCsv(overview: UsageOverview, exportedAt: number): string {
  const sentFrom = usageDateKey(new Date(usageWeekStart((new Date(overview.messages.through).getDay() + 1) % 7, overview.messages.through)));
  const sent = new Map(overview.messages.days.map(day => [day.date, day]));
  const tokens = new Map(overview.days.map(day => [day.date, day.tokens]));
  const dates = [...new Set([...tokens.keys(), ...sent.keys()])].sort();
  const rows: Array<Array<string | number | null>> = [
    ['Chat On Steroids usage export', usageCsvTime(exportedAt)],
    ['Note', `Estimated tokens are this app's local estimate (the input and visible output of every model round trip; hidden reasoning is not visible), not a provider invoice or exact token use. Messages sent count recorded native sends with verified model proof for the last 7 days only; they are not a quota. Limits are the latest reading only. Times are local.`],
    [],
    ['Date', 'Estimated tokens', 'GPT-5.6 messages sent', 'GPT-6 messages sent'],
    ...dates.map(date => {
      const day = sent.get(date);
      const counted = date >= sentFrom;
      return [date, Math.round(tokens.get(date) ?? 0), counted ? day?.gpt56 ?? 0 : null, counted ? day?.gpt6 ?? 0 : null];
    }),
    [],
    ['Limit', 'Kind', 'Remaining', 'Remaining percent', 'Window hours', 'Resets at', 'Read at'],
    ...overview.limits.map(limit => [limit.model, limit.scope, limit.remaining, limit.remainingPercent === null ? null : Math.round(limit.remainingPercent * 10) / 10,
      limit.windowSeconds === null ? null : Math.round(limit.windowSeconds / 360) / 10, limit.resetAt === null ? null : usageCsvTime(limit.resetAt), usageCsvTime(limit.observedAt)])
  ];
  // A byte-order mark makes Excel read the file as UTF-8.
  return `﻿${rows.map(row => row.map(usageCsvCell).join(',')).join('\r\n')}\r\n`;
}
