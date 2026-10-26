import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageMessageTotals } from '../src/shared/usage.js';
const store = vi.hoisted(() => ({ listUsageSessions: vi.fn(), readEvents: vi.fn() }));
vi.mock('../src/main/session/store.js', () => store);
const catalog = vi.hoisted(() => ({ getChatModels: vi.fn() }));
vi.mock('../src/main/chat-models.js', () => catalog);
const durable = vi.hoisted(() => ({ readDurable: vi.fn(), writeDurableSoon: vi.fn() }));
vi.mock('../src/main/durable.js', () => durable);
const logger = vi.hoisted(() => ({ logInfo: vi.fn() }));
vi.mock('../src/main/logger.js', async (importOriginal) => ({ ...(await importOriginal<object>()), logInfo: logger.logInfo }));
let usage: typeof import('../src/main/session/usage.js');
let now: number;
const limit = (overrides: Record<string, unknown> = {}) => ({ model: 'Shared ChatGPT usage', scope: 'shared', remaining: null, remainingPercent: 40, resetAt: null, windowSeconds: 18000, ...overrides });
beforeEach(async () => {
  vi.resetModules();
  catalog.getChatModels.mockReset().mockReturnValue({ models: [] });
  durable.readDurable.mockReset().mockResolvedValue(null); durable.writeDurableSoon.mockReset();
  store.listUsageSessions.mockReset().mockResolvedValue([]);
  store.readEvents.mockReset().mockResolvedValue([]);
  now = Date.parse('2026-09-05T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  usage = await import('../src/main/session/usage.js');
});
afterEach(() => vi.restoreAllMocks());
// Token parts are checked where a test is about them; elsewhere a row is its identity and total.
const plain = <T extends { parts?: unknown }>(rows: readonly T[]) => rows.map(({ parts: _parts, ...row }) => row);
it('logs an overview pass only when it rebuilt something, not each refresh of the open page', async () => {
  store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 0 }]);
  logger.logInfo.mockReset();
  await usage.usageOverview();
  expect(logger.logInfo).toHaveBeenCalledTimes(1);
  expect(logger.logInfo.mock.calls[0]![0]).toContain('rebuilt=1');
  await usage.usageOverview();
  await usage.usageOverview();
  expect(logger.logInfo).toHaveBeenCalledTimes(1);
});
describe('verified native message counts', () => {
  const message = (messageId: string | undefined, model: string | undefined, time: number, extra = {}) =>
    ({ kind: 'user_message', messageId, model, time, message: { text: '' }, ...extra });
  beforeEach(() => {
    now = new Date(2026, 8, 21, 12).getTime(); // Monday, in the machine's local timezone.
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 20, estimatedTokens: 0,
      selectedModel: { model: 'gpt-6-pro', observedAt: now } }]);
  });

  it('counts proven native sends including image-only messages, without borrowing model or tool evidence', async () => {
    store.readEvents.mockResolvedValue([
      message('sol', 'gpt-5-6-thinking', now), message('old-pro', 'gpt-5-6-pro', now),
      message('astra', 'gpt-6-astra', now), message('image-only', 'gpt-6-pro', now),
      message('input:injected', 'gpt-6-pro', now, { inputDelivery: 'confirmed' }),
      message('unconfirmed', 'gpt-6-pro', now, { inputDelivery: 'offered' }),
      message('no-model', undefined, now), message(undefined, 'gpt-6-pro', now),
      message('unrecognized', 'gpt-6-pro-future', now),
      { kind: 'tool_call', time: now, call: { callId: 'tool', conversationId: 'chat', model: 'gpt-6-pro', args: { text: '' }, result: { text: '' }, summary: { title: '' } } }
    ]);
    const result = await usage.usageOverview();
    expect(usageMessageTotals(result.messages, 1)).toMatchObject({ gpt56: 2, gpt6: 2 });
    expect(result.tokens).toBe(0);
  });

  it('proves a page-typed send by the model ChatGPT resolved for its own reply, and only that reply', async () => {
    const reply = (resolvedModel: string | undefined, extra = {}) =>
      ({ kind: 'assistant_message', time: now, final: true, message: { text: '' }, ...(resolvedModel ? { resolvedModel } : {}), ...extra });
    store.readEvents.mockResolvedValue([
      // Counted: the first reply after the send names a known model.
      message('typed-56', undefined, now), reply('gpt-5-6-thinking'), reply('gpt-6-pro'),
      message('typed-6', undefined, now), reply(undefined), reply('gpt-6-astra'),
      // Not counted: an unknown slug, a reply after the next send, and an injected app message.
      message('typed-other', undefined, now), reply('gpt-5-4-auto-thinking'),
      message('no-reply', undefined, now), message('input:injected', undefined, now, { inputDelivery: 'confirmed' }), reply('gpt-6-pro'),
      // An explicit but unrecognised own model abstains instead of borrowing the reply's.
      message('own-unknown', 'gpt-6-pro-future', now), reply('gpt-6-pro')
    ]);
    const result = await usage.usageOverview();
    expect(usageMessageTotals(result.messages, 1)).toMatchObject({ gpt56: 1, gpt6: 1 });
  });

  it('uses the original timestamp and an inclusive midnight boundary, excluding older and future sends', async () => {
    const saturday = new Date(2026, 8, 19).getTime();
    store.readEvents.mockResolvedValue([
      message('before', 'gpt-6-pro', saturday - 1), message('at-start', 'gpt-6-pro', saturday),
      message('now', 'gpt-6-pro', now), message('future', 'gpt-6-pro', now + 1),
      message('old-replayed', 'gpt-6-pro', now, { authoredAt: new Date(2026, 8, 12).getTime() }),
      message('bad-time', 'gpt-6-pro', now, { authoredAt: NaN }),
      message('zero-time', 'gpt-6-pro', now, { authoredAt: 0 })
    ]);
    const result = await usage.usageOverview();
    expect(result.messages.through).toBe(now);
    expect(usageMessageTotals(result.messages, 6)).toEqual({ date: '2026-09-19', gpt56: 0, gpt6: 2 });
    expect(usageMessageTotals(result.messages, 1)).toMatchObject({ gpt6: 1 });
    now++;
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ gpt6: 2 });
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });

  it('deduplicates native identities across replays and copied history, abstaining on conflicting evidence', async () => {
    store.listUsageSessions.mockResolvedValue(['one', 'two'].map(id => ({ id, updatedAt: 1, events: 4, estimatedTokens: 0 })));
    const native = message('native-id', 'gpt-6-pro', now);
    store.readEvents.mockResolvedValueOnce([native, native, message('conflicting', 'gpt-6-pro', now)])
      .mockResolvedValueOnce([native, message('conflicting', 'gpt-5.6', now)]);
    const first = await usage.usageOverview();
    expect(usageMessageTotals(first.messages, 1)).toMatchObject({ gpt56: 0, gpt6: 1 });
    first.messages.days[0]!.gpt6 = 999;
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ gpt6: 1 });
    expect(store.readEvents).toHaveBeenCalledTimes(2);
  });

  it('reuses verified timestamps after restart and advances the week without rereading unchanged recordings', async () => {
    store.readEvents.mockResolvedValue([message('native', 'gpt-6-pro', now)]);
    await usage.usageOverview();
    const saved = structuredClone(durable.writeDurableSoon.mock.calls.at(-1)![1]);
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ gpt6: 1 });
    now = new Date(2026, 8, 28).getTime();
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toEqual({ date: '2026-09-28', gpt56: 0, gpt6: 0 });
    expect(store.readEvents).not.toHaveBeenCalled();
  });

  it('incorporates late verified model evidence and removes deleted recordings from counts', async () => {
    store.readEvents.mockResolvedValue([message('native', undefined, now)]);
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ gpt6: 0 });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 20, estimatedTokens: 0 }]);
    store.readEvents.mockResolvedValue([message('native', 'gpt-6-pro', now)]);
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ gpt6: 1 });
    store.listUsageSessions.mockResolvedValue([]);
    expect((await usage.usageOverview()).messages.days).toEqual([]);
  });
});
describe('passive usage limits and canonical token totals', () => {
  it('counts only the outer code-mode exchange while retaining ordinary calls sharing its request', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, nested = false) => ({ kind: 'tool_call', time, call: {
      callId, nested, requestId: 'same-generation', conversationId: 'chat',
      args: { text: 'aaaa' }, result: nested ? { text: 'preview', truncated: true, chars: 80_000 } : { text: 'bbbb' }, summary: { title: '' }
    } });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 4, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([call('child-a', true), call('child-b', true), call('outer'), call('direct')]);
    // Four context tokens, two real exchanges. Children add neither text nor billing calls.
    expect((await usage.usageOverview()).tokens).toBe(4);
  });
  it('keeps Codex windows distinct and does not manufacture model-specific counts', async () => {
    usage.observeUsage([limit({ scope: 'codex' }), limit({ windowSeconds: 604800, remainingPercent: 70, scope: 'codex' }), limit({ model: 'gpt-example', scope: 'model', remaining: 3, remainingPercent: null })]);
    const result = await usage.usageOverview();
    expect(result.limits).toHaveLength(3);
    expect(result.limits.filter(row => row.scope === 'codex').map(row => row.remaining)).toEqual([null, null]);
    expect(result.limits.filter(row => row.scope === 'model')).toEqual([expect.objectContaining({ model: 'gpt-example', remaining: 3, remainingPercent: null })]);
    result.limits[0]!.remainingPercent = 99;
    expect((await usage.usageOverview()).limits[0]?.remainingPercent).toBe(40);
  });
  // An extension from before 2.1.40 still sends wham/usage windows as "shared"; they were Codex's.
  it('reads the old "shared" rows as Codex', () => {
    usage.observeUsage([limit({ model: 'Shared usage', scope: 'shared' })]);
    expect(usage.reportedUsageLimits()).toEqual([expect.objectContaining({ model: 'Codex', scope: 'codex', remainingPercent: 40 })]);
  });
  it.each([{ remaining: -1 }, { remaining: Infinity }, { remainingPercent: 101 }, { remainingPercent: NaN }, { resetAt: -1 }, { windowSeconds: 0 }, { scope: 'guessed' }])('rejects malformed batch atomically (%j)', async (bad) => {
    usage.observeUsage([limit()]);
    expect(() => usage.observeUsage([limit({ remainingPercent: 10 }), limit(bad)])).toThrow();
    expect((await usage.usageOverview()).limits[0]?.remainingPercent).toBe(40);
  });
  it('expires a snapshot on read even when no further provider response arrives', async () => {
    usage.observeUsage([limit()]);
    now += 10 * 60000 + 1;
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('rejects an oversized row batch without replacing the current snapshot', async () => {
    usage.observeUsage([limit()]);
    expect(() => usage.observeUsage(Array.from({ length: 81 }, (_, index) => limit({ model: `model-${index}` })))).toThrow();
    expect((await usage.usageOverview()).limits).toHaveLength(1);
  });
  it('replaces an account snapshot and accepts an explicit empty reset', async () => {
    usage.observeUsage([limit(), limit({ model: 'gpt-old', scope: 'model', remaining: 0 })]);
    now += 1;
    usage.observeUsage([limit({ model: 'gpt-new', scope: 'model', remaining: 5 })]);
    expect((await usage.usageOverview()).limits.map(row => row.model)).toEqual(['gpt-new']);
    now += 1;
    usage.observeUsage([]);
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('refuses older, stale and future snapshots and does not renew a replay timestamp', async () => {
    usage.observeUsage([limit()], now);
    for (const timestamp of [now - 1, now - 11 * 60000, now + 6000, NaN, 'invalid']) {
      usage.observeUsage([limit({ remainingPercent: 99 })], timestamp);
      expect((await usage.usageOverview()).limits[0]?.remainingPercent).toBe(40);
    }
    const captured = now;
    now += 9 * 60000;
    usage.observeUsage([limit()], captured);
    expect((await usage.usageOverview()).limits[0]?.observedAt).toBe(captured);
    now += 60001;
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('removes exhausted pre-reset observations without inventing a replenished balance', async () => {
    usage.observeUsage([limit({ model: 'gpt-example', scope: 'model', remaining: 0, remainingPercent: null, resetAt: now + 1000 })]);
    now += 1001;
    expect((await usage.usageOverview()).limits).toEqual([]);
  });
  it('recomputes changed session revisions and removes deleted sessions from daily totals', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 1 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    expect(await usage.usageOverview()).toMatchObject({ tokens: 1, sessions: 1, days: [{ date: '2026-09-05', tokens: 1 }] });
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 1, estimatedTokens: 2 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaaaaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).days).toMatchObject([{ date: '2026-09-05', tokens: 2 }]);
    expect(store.readEvents).toHaveBeenCalledTimes(2);
    store.listUsageSessions.mockResolvedValue([]);
    expect(await usage.usageOverview()).toMatchObject({ tokens: 0, sessions: 0, days: [] });
  });
  it('charges each unique round trip the context it reads and the call it writes', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, conversationId = 'a') => ({ kind: 'tool_call', time, call: { callId, conversationId, args: { text: 'aaaa' }, result: { text: 'bbbb' }, summary: { title: '' } } });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 6, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time, message: { text: 'aaaa' } },
      call('1'), call('2'), call('2'), call('3', 'b')
    ]);
    // First frontend: 1 + 1, then 3 (2 of them cached) + 1; the repeat is not a round trip; the
    // second frontend starts empty: 0 + 1. 7 in all.
    const results = await Promise.all([usage.usageOverview(), usage.usageOverview()]);
    expect(results[0]?.tokens).toBe(7);
    expect(results[0]?.days[0]?.tokens).toBe(7);
    expect(results[0]?.models[0]?.parts).toEqual({ input: 2, cached: 2, output: 3, longInput: 0, longCached: 0, longOutput: 0 });
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });
  it('assigns work to the round trip\'s day, charges a final answer, and not authored-only sessions', async () => {
    const first = new Date(2026, 8, 4, 23, 59).getTime();
    const second = new Date(2026, 8, 5, 0, 1).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 3, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time: first, message: { text: 'aaaa' } },
      { kind: 'tool_call', time: second, call: { callId: 'one', conversationId: 'a', args: { text: 'bbbb' }, result: { text: '' }, summary: { title: '' } } },
      { kind: 'assistant_message', time: second, message: { text: 'cccc' } }
    ]);
    // The call reads 1 and writes 1; the answer reads 2 and writes 1.
    expect((await usage.usageOverview()).days).toMatchObject([{ date: '2026-09-05', tokens: 5 }]);
    store.listUsageSessions.mockResolvedValue([{ id: 'text-only', updatedAt: 1, events: 1, estimatedTokens: 99 }]);
    store.readEvents.mockResolvedValue([{ kind: 'user_message', time: first, message: { text: 'aaaa' } }]);
    expect((await usage.usageOverview()).tokens).toBe(0);
  });
  it('reuses valid persisted revisions after restart without rereading transcripts', async () => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 1 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    const first = await usage.usageOverview();
    const persisted = durable.writeDurableSoon.mock.calls.at(-1)![1];
    vi.resetModules(); durable.readDurable.mockResolvedValue(persisted); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect((await usage.usageOverview()).tokens).toBe(first.tokens);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('caps each round trip\'s input at the ceiling and serves the repeated prefix from the cache', async () => {
    const first = new Date(2026, 8, 4, 12).getTime();
    const second = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, time: number, model: string, conversationId = 'a') => ({ kind: 'tool_call', time, call: { callId, conversationId, model, args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } });
    const session = { id: 'one', updatedAt: 1, events: 9, estimatedTokens: 2_000_000, contextTokens: 2_000_000 };
    const events = [
      { kind: 'user_message', time: first, message: { text: 'preview', truncated: true, chars: 8_000_000 } },
      call('1', first, 'gpt-6-pro'), call('2', first, 'gpt-6-pro'), call('3', first, 'gpt-6-pro'),
      call('4', second, 'gpt-5-6-thinking'), call('4', second, 'gpt-5-6-thinking'),
      { kind: 'session_start', time: second, conversationId: 'b' },
      { kind: 'user_message', time: second, message: { text: 'aaaa' } },
      call('5', second, 'gpt-6-pro', 'b')
    ];
    store.listUsageSessions.mockResolvedValue([session]); store.readEvents.mockResolvedValue(events);
    const result = await usage.usageOverview();
    // Four capped round trips of 256,000 + 1, then a fresh frontend's 1 + 1.
    expect(result.tokens).toBe(1_024_006);
    expect(result.days.map(day => [day.date, day.tokens])).toEqual([['2026-09-04', 768_003], ['2026-09-05', 256_003]]);
    expect(result.models).toEqual([
      { model: 'gpt-6-pro', reasoningEffort: null, assumed: false, tokens: 768_005, parts: { input: 256_001, cached: 512_000, output: 4, longInput: 0, longCached: 0, longOutput: 0 } },
      { model: 'gpt-5-6-thinking', reasoningEffort: null, assumed: false, tokens: 256_001, parts: { input: 0, cached: 256_000, output: 1, longInput: 0, longCached: 0, longOutput: 0 } }
    ]);
    expect(session).toMatchObject({ estimatedTokens: 2_000_000, contextTokens: 2_000_000 });
    const { eventTokens } = await import('../src/shared/session.js');
    expect(eventTokens(events[0] as Parameters<typeof eventTokens>[0])).toBe(2_000_000);
  });
  it('bills a round trip past 272K input tokens at the long-context rates', async () => {
    catalog.getChatModels.mockReturnValue({ models: [{ id: 'gpt-6-pro', efforts: [] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 3, estimatedTokens: 300_000 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time: now, messageId: 'native', model: 'gpt-6-pro', message: { text: '', truncated: true, chars: 1_200_000 } },
      { kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } },
      { kind: 'assistant_message', time: now, messageId: 'answer', message: { text: 'aaaa' } },
      { kind: 'assistant_message', time: now, messageId: 'answer', message: { text: 'aaaa' } }
    ]);
    const [row] = (await usage.usageOverview()).models;
    // The answer reads the call's whole prefix back from the cache.
    expect(row?.parts).toEqual({ input: 0, cached: 0, output: 0, longInput: 300_000, longCached: 300_001, longOutput: 2 });
    const { DEFAULT_USAGE_FORMULA, usageEstimate } = await import('../src/shared/usage.js');
    // Astra: 300,000 × $20 + 300,001 × $2 + 2 × $75 per million, then × 1.2.
    expect(usageEstimate([row!], DEFAULT_USAGE_FORMULA).cost).toBeCloseTo((300_000 * 20 + 300_001 * 2 + 2 * 75) / 1e6 * 1.2);
  });
  it.each([255_999, 256_000, 256_001, 2_000_000])('bounds a %i-token round trip without scaling a short one', async (context) => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: context }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: '', truncated: true, chars: context * 4 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(Math.min(context, 256_000));
  });
  it.each([
    { id: 'gpt-6-pro', efforts: [] },
    { id: 'gpt-6-astra', efforts: ['high'] },
    { id: 'gpt-5-6-pro', efforts: [] },
    { id: 'gpt-5-6-thinking', efforts: ['high', 'pro'] }
  ])('uses a selectable Pro option %j to raise every model to 400K', async (option) => {
    catalog.getChatModels.mockReturnValue({ models: [option] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 2, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue(['gpt-5-6-thinking', 'gpt-6-pro'].map((model, i) => ({ kind: 'tool_call', time: now,
      call: { callId: String(i), conversationId: 'chat', model, args: { text: '', truncated: true, chars: 4_000_000 }, result: { text: '' }, summary: { title: '' } } })));
    const result = await usage.usageOverview();
    expect(result.contextTokenCap).toBe(400_000);
    // The first writes 400K; the second reads it back from the cache and writes 400K more.
    expect(result.models.map(row => row.tokens)).toEqual([400_000, 800_000]);
    expect(result.tokens).toBe(1_200_000);
  });
  it.each([399_999, 400_000, 400_001])('caps a Pro account\'s round trip of %i at 400K', async context => {
    catalog.getChatModels.mockReturnValue({ models: [{ id: 'gpt-6-pro', efforts: [] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: context }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'gpt-5.6',
      args: { text: '', truncated: true, chars: context * 4 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(Math.min(context, 400_000));
  });
  it('rebuilds unchanged recordings when Pro availability changes, while ordinary catalog updates reuse the cache', async () => {
    const ordinary = { id: 'gpt-5-6-thinking', efforts: ['high'] };
    catalog.getChatModels.mockReturnValue({ models: [ordinary, { id: 'unknown-pro-lookalike', efforts: ['high'] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'gpt-6-pro',
      args: { text: '', truncated: true, chars: 8_000_000 }, result: { text: '' }, summary: { title: '' } } }]);
    // Historical Pro usage does not establish current selectable models.
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 256_000, tokens: 256_000 });
    catalog.getChatModels.mockReturnValue({ models: [ordinary, { id: 'gpt-6-pro', efforts: [] }] });
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 400_000, tokens: 400_000 });
    expect(store.readEvents).toHaveBeenCalledTimes(2);
    const saved = durable.writeDurableSoon.mock.calls.at(-1)![1];
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    catalog.getChatModels.mockReturnValue({ models: [ordinary, { id: 'gpt-6-pro', efforts: ['high'] }] });
    expect((await usage.usageOverview()).tokens).toBe(400_000);
    expect(store.readEvents).not.toHaveBeenCalled();
    catalog.getChatModels.mockReturnValue({ models: [ordinary] });
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 256_000, tokens: 256_000 });
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });
  it.each([4, 5, 6, 7, 8, 9])('rebuilds old cache version %i and reuses the corrected cache after restart', async (version) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    durable.readDurable.mockResolvedValue({ version, rows: [{ id: 'one', revision: `${timezone}:1:1:2000000`, days: [['2026-09-05', [{ model: 'gpt-6-pro', reasoningEffort: null, assumed: false, tokens: 1_000_000 }]]] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'gpt-6-pro', args: { text: '', truncated: true, chars: 8_000_000 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(256_000);
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    const persisted = durable.writeDurableSoon.mock.calls.at(-1)![1];
    expect(persisted.version).toBe(10);
    vi.resetModules(); durable.readDurable.mockResolvedValue(persisted); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect((await usage.usageOverview()).tokens).toBe(256_000);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('caps each tool result before the next round trip reads it', async () => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 3, estimatedTokens: 400000 }]);
    store.readEvents.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ kind: 'tool_call', time: now,
      call: { callId: String(i), conversationId: 'chat', args: { text: '' },
        result: { text: 'preview', truncated: true, chars: 524582 }, summary: { title: '' } } })));
    // Each result adds 10,000 capped tokens: the round trips read 0, 10,000 and 20,000.
    expect((await usage.usageOverview()).tokens).toBe(30_000);
  });

  it('releases a failed calculation so opening again can retry', async () => {
    store.listUsageSessions.mockRejectedValueOnce(new Error('temporary read failure'));
    await expect(usage.usageOverview()).rejects.toThrow('temporary read failure');
    expect((await usage.usageOverview()).tokens).toBe(0);
  });
  it('shares background work with page visits and reads changed sessions one at a time', async () => {
    store.listUsageSessions.mockResolvedValue(['one', 'two'].map(id => ({ id, updatedAt: 1, events: 1, estimatedTokens: 0 })));
    let release!: () => void;
    store.readEvents.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const background = usage.usageOverview(new AbortController().signal);
    expect(usage.usageOverview()).toBe(background);
    await vi.waitFor(() => expect(store.readEvents).toHaveBeenCalledTimes(1));
    expect(store.readEvents.mock.calls[0]).toEqual(['one']);
    release();
    await background;
    expect(store.readEvents.mock.calls).toEqual([['one'], ['two']]);
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(2);
  });
  it('cancels warmup between reads without publishing a partial cache and permits a later retry', async () => {
    store.listUsageSessions.mockResolvedValue(['one', 'two'].map(id => ({ id, updatedAt: 1, events: 1, estimatedTokens: 0 })));
    const controller = new AbortController();
    store.readEvents.mockImplementationOnce(async () => { controller.abort(); return []; });
    await expect(usage.usageOverview(controller.signal)).rejects.toThrow();
    expect(store.readEvents.mock.calls).toEqual([['one']]);
    expect(durable.writeDurableSoon).not.toHaveBeenCalled();
    expect((await usage.usageOverview()).sessions).toBe(2);
    expect(durable.writeDurableSoon).toHaveBeenCalledTimes(1);
  });
});

describe('model attribution and equivalent cost', () => {
  const call = (id: string, extra = {}) => ({ kind: 'tool_call', time: new Date(2026, 8, 5, 12).getTime(), call: { callId: id, conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' }, ...extra } });
  const message = (model?: string, reasoningEffort?: string, messageId = 'native') => ({ kind: 'user_message', time: now, messageId, message: { text: 'aaaa' }, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
  beforeEach(() => store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 10, estimatedTokens: 10 }]));
  it('attributes each round trip to its model and effort without duplicating calls', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), message('model-b', 'low'), call('b'), call('b')]);
    const result = await usage.usageOverview();
    expect(result.tokens).toBe(6);
    expect(plain(result.models)).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2 },
      { model: 'model-b', reasoningEffort: 'low', assumed: false, tokens: 4 }
    ]);
    expect(result.days[0]?.models).toEqual(result.models);
  });
  it('a native user row without evidence clears earlier selection; injected rows neither select nor clear', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), message('wrong', 'low', 'input:x'), call('a'), message(), call('b')]);
    expect(plain((await usage.usageOverview()).models)).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 3 },
      { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 5 }
    ]);
  });
  it('direct call model overrides only that call and never inherits a different models effort', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a', { model: 'model-b' }), call('b')]);
    expect(plain((await usage.usageOverview()).models)).toEqual([
      { model: 'model-b', reasoningEffort: null, assumed: false, tokens: 2 },
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 3 }
    ]);
  });
  it('a recorded legacy model name without effort does not turn assumed High into evidence', async () => {
    store.readEvents.mockResolvedValue([message('gpt-5.6'), call('a')]);
    expect(plain((await usage.usageOverview()).models)).toEqual([
      { model: 'gpt-5.6', reasoningEffort: null, assumed: false, tokens: 2 }
    ]);
  });
  it('new frontend and unattributed calls cannot inherit the previous model', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), call('b', { conversationId: 'other' }), call('c', { conversationId: null })]);
    const result = await usage.usageOverview();
    expect(plain(result.models)).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2 },
      { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 2 }
    ]);
  });
  it('keeps effort changes for the same model separate and late evidence invalidates the saved revision', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), message('model-a', 'low'), call('b')]);
    expect((await usage.usageOverview()).models.map(row => row.reasoningEffort)).toEqual(['high', 'low']);
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 10, estimatedTokens: 10 }]);
    store.readEvents.mockResolvedValue([message('model-b', 'low'), call('a')]);
    expect(plain((await usage.usageOverview()).models)).toEqual([{ model: 'model-b', reasoningEffort: 'low', assumed: false, tokens: 2 }]);
  });
  it('reuses model totals from persisted cache without transcript reads or aliasing returned values', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a')]);
    const first = await usage.usageOverview();
    const saved = structuredClone(durable.writeDurableSoon.mock.calls.at(-1)![1]);
    first.models[0]!.tokens = 999;
    first.days[0]!.models[0]!.tokens = 999;
    first.models[0]!.parts.input = 999;
    expect((await usage.usageOverview()).tokens).toBe(2);
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../src/main/session/usage.js');
    expect((await usage.usageOverview()).models).toEqual([{ model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2, parts: { input: 1, cached: 0, output: 1, longInput: 0, longCached: 0, longOutput: 0 } }]);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  // Short-context input, cached input and output, so each test reads its rates straight off.
  const priced = (model: string, input: number, cached: number, output: number, extra = {}) => ({ model, reasoningEffort: 'high', assumed: false,
    tokens: input + cached + output, parts: { input, cached, output, longInput: 0, longCached: 0, longOutput: 0 }, ...extra });
  it('prices input, cached input and output separately while exposing unknown cost', async () => {
    const { usageEstimate } = await import('../src/shared/usage.js');
    const rows = [priced('a', 1e6, 2e6, 1e6), priced('b', 0, 0, 2e6, { reasoningEffort: 'low' }), priced('unknown', 1e6, 0, 0, { reasoningEffort: null })];
    const rates = { a: { input: 2, cached: 0.2, output: 10 }, b: { input: 1, cached: 0.1, output: 5 } };
    // a: 2 + 0.4 + 10; b: 10. Then × 1.2.
    const estimate = usageEstimate(rows, { multiplier: 1.2, rates });
    expect(estimate).toMatchObject({ tokens: 7e6, unpricedTokens: 1e6 });
    expect(estimate.cost).toBeCloseTo(26.88);
    expect(usageEstimate(rows, { multiplier: 1, rates: { ...rates, a: null } })).toMatchObject({ cost: 10, unpricedTokens: 5e6 });
    expect(rows[0]!.tokens).toBe(4e6);
  });
  it('prices the recorded Sol picker ID without changing its identity or overriding saved rates', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate } = await import('../src/shared/usage.js');
    const rows = [priced('gpt-5-6-thinking', 100_000, 1_000_000, 10_000)];
    // GPT-5.6 Sol: $4 input, $0.40 cached, $20 output.
    expect(usageEstimate(rows, DEFAULT_USAGE_FORMULA).cost).toBeCloseTo((0.4 + 0.4 + 0.2) * 1.2);
    for (const rate of [null, { input: 0, cached: 0, output: 0 }, { input: 8, cached: 0.8, output: 40 }]) {
      const estimate = usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates, 'gpt-5-6-thinking': rate } });
      expect(estimate.unpricedTokens).toBe(rate === null ? 1_110_000 : 0);
      expect(estimate.cost).toBeCloseTo(rate === null ? 0 : rate.input === 0 ? 0 : 2 * 1.2);
    }
    expect(usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { 'gpt-5.6-sol': { input: 8, cached: 0.8, output: 40 } } }).cost).toBeCloseTo(2.4);
    expect(usageEstimate([{ ...rows[0]!, model: 'gpt-5-6-thinking-unknown' }], DEFAULT_USAGE_FORMULA).unpricedTokens).toBe(1_110_000);
    expect(rows[0]!.model).toBe('gpt-5-6-thinking');
  });
  it('prices every published model and the ChatGPT aliases from the API price list', async () => {
    const { DEFAULT_USAGE_FORMULA, usageRate } = await import('../src/shared/usage.js');
    const rate = (model: string) => usageRate(model, DEFAULT_USAGE_FORMULA);
    expect(rate('gpt-6-pro')).toEqual({ input: 10, cached: 1, output: 50 });
    expect(rate('6')).toEqual(rate('gpt-6-astra'));
    expect(rate('gpt-6.1-sol')).toEqual({ input: 2, cached: 0.1, output: 10 });
    expect(rate('gpt-6.1-terra')).toEqual({ input: 1, cached: 0.05, output: 5 });
    expect(rate('gpt-6-luna')).toEqual({ input: 0.1, cached: 0.01, output: 0.5 });
    for (const id of ['gpt-6', 'gpt-6-thinking', 'gpt-6-instant']) expect(rate(id)).toEqual({ input: 2, cached: 0.2, output: 10 });
    for (const id of ['5.6', 'gpt-5.6', 'gpt-5-6', 'gpt-5-6-instant', 'gpt-5-6-thinking']) expect(rate(id)).toEqual({ input: 4, cached: 0.4, output: 20 });
    expect(rate('gpt-5.6-terra')).toEqual({ input: 2, cached: 0.2, output: 12 });
    expect(rate('gpt-5.6-luna')).toEqual({ input: 0.2, cached: 0.02, output: 1.2 });
    for (const id of ['5.5', 'gpt-5-5', 'gpt-5-5-instant', 'gpt-5-5-thinking']) expect(rate(id)).toEqual({ input: 5, cached: 0.5, output: 30 });
    // GPT-5.5 Pro has no cached-input discount, and ChatGPT's GPT-5.6 Pro is priced as it.
    expect(rate('gpt-5-6-pro')).toEqual({ input: 30, cached: 30, output: 180 });
    expect(rate('gpt-6-sol-wm')).toBeUndefined();
  });
  it('groups known aliases without merging effort, provenance or distinct models and preserves per-ID rates', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate, usageModelGroups } = await import('../src/shared/usage.js');
    const rows = [
      ...['5.6', 'gpt-5.6', 'gpt-5-6-thinking', 'gpt-5.6-sol'].map(model => priced(model, 0, 1e6, 0)),
      priced('gpt-5-6-pro', 0, 1e6, 0, { reasoningEffort: 'pro' }),
      priced('gpt-5.6', 0, 1e6, 0, { assumed: true }),
      priced('gpt-5.6-sol', 0, 1e6, 0, { reasoningEffort: null }),
      ...['gpt-6-pro', 'gpt-5.6-terra', 'gpt-5.6-luna', '5.6-unknown'].map(model => priced(model, 0, 1e6, 0, { reasoningEffort: 'pro' }))
    ];
    const groups = usageModelGroups(rows);
    expect(groups).toHaveLength(8);
    expect(groups[0]).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'high', assumed: false });
    expect(groups[0]!.sources).toHaveLength(4);
    expect(groups[1]).toMatchObject({ model: 'gpt-5.5-pro', reasoningEffort: 'pro' });
    expect(usageEstimate(groups[1]!.sources, DEFAULT_USAGE_FORMULA).cost).toBeCloseTo(36);
    const formula = { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates, '5.6': null, 'gpt-5-6-thinking': { input: 0, cached: 0, output: 0 }, 'gpt-5.6': { input: 8, cached: 0.8, output: 40 } } };
    const grouped = usageEstimate(groups[0]!.sources, formula);
    expect(grouped).toMatchObject({ tokens: 4e6, unpricedTokens: 1e6 });
    expect(grouped.cost).toBeCloseTo((0.8 + 0.4) * 1.2);
    expect(usageEstimate(rows.slice(-1), DEFAULT_USAGE_FORMULA).unpricedTokens).toBe(1e6);
    expect(rows[0]!.model).toBe('5.6');
  });
});

describe('usage by project', () => {
  const time = new Date(2026, 8, 5, 12).getTime();
  const call = (id: string, model?: string) => ({ kind: 'tool_call', time, call: { callId: id, conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' }, ...(model ? { model } : {}) } });
  const session = (id: string, projectId?: string) => ({ id, updatedAt: 1, events: 2, estimatedTokens: 2, ...(projectId ? { projectId } : {}) });
  const recordings: Record<string, unknown[]> = {
    one: [call('a', 'gpt-6-pro')],
    two: [call('a', 'model-b'), call('b', 'model-b')],
    three: [call('a')],
    loose: [call('a'), call('b')],
    quiet: [{ kind: 'user_message', time, messageId: 'native', message: { text: 'aaaa' } }]
  };
  it('groups the cached per-chat totals by each chat\'s current project and regroups a moved chat without rereading it', async () => {
    store.readEvents.mockImplementation(async (id: string) => recordings[id] ?? []);
    store.listUsageSessions.mockResolvedValue([session('one', 'alpha'), session('two', 'alpha'), session('three', 'beta'), session('loose'), session('quiet', 'gamma')]);
    const first = await usage.usageOverview();
    // A chat outside every project is its own row; a project without tool calls has none.
    expect(first.projects.map(project => ({ ...project, models: plain(project.models) }))).toEqual([
      { projectId: 'alpha', tokens: 4, models: [
        { model: 'gpt-6-pro', reasoningEffort: null, assumed: false, tokens: 1 },
        { model: 'model-b', reasoningEffort: null, assumed: false, tokens: 3 }
      ] },
      { projectId: null, tokens: 3, models: [{ model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 3 }] },
      { projectId: 'beta', tokens: 1, models: [{ model: 'gpt-5.6', reasoningEffort: 'high', assumed: true, tokens: 1 }] }
    ]);
    expect(first.projects.reduce((sum, project) => sum + project.tokens, 0)).toBe(first.tokens);
    expect(store.readEvents).toHaveBeenCalledTimes(5);
    // Moving a chat keeps its recording revision: its whole history moves with it, from the cache.
    store.listUsageSessions.mockResolvedValue([session('one', 'alpha'), session('two', 'beta'), session('three', 'beta'), session('loose'), session('quiet', 'gamma')]);
    const moved = await usage.usageOverview();
    expect(moved.projects.map(project => [project.projectId, project.tokens])).toEqual([['beta', 4], [null, 3], ['alpha', 1]]);
    expect(store.readEvents).toHaveBeenCalledTimes(5);
  });
});
