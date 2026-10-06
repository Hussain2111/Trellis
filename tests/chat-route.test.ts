import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import { POST } from '../app/api/chat/route';

const state = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  runs: vi.fn(),
  resolveLanes: vi.fn(),
  headroom: { allowed: true, used: 0, limit: 80 },
}));
vi.mock('../lib/db/client', () => ({ db: () => ({ insert: () => ({ values: state.runs }) }) }));
vi.mock('../lib/chat/threads', () => ({
  appendMessage: state.appendMessage,
  selfAccountId: async () => 1,
  findThread: async () => ({ sourceCardId: null }),
  threadMessages: async () => [{ role: 'user', content: 'Highest views?' }],
  titleThread: async () => {},
  buildSystemPrompt: async () => 'Use queried evidence.',
  ledgerFor: () => ({}),
}));
vi.mock('../lib/model/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/model/provider')>()),
  resolveLanes: state.resolveLanes,
  checkHeadroom: async () => state.headroom,
  quotaCaps: () => ({ dailyCalls: 100, reservedForCards: 20, callsPerMinute: 5 }),
}));
vi.mock('../lib/chat/tools', () => ({
  chatTools: () => ({
    getPostsRanked: tool({ inputSchema: z.object({}), execute: async () => ({ views: 1248 }) }),
  }),
}));

function response(text?: string): LanguageModelV3GenerateResult {
  return {
    content:
      text === undefined
        ? [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'getPostsRanked', input: '{}' }]
        : [{ type: 'text', text }],
    finishReason: { unified: text === undefined ? 'tool-calls' : 'stop', raw: undefined },
    warnings: [],
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
  };
}
const lane = (model: MockLanguageModelV3, provider = 'google', isFallback = false) => ({
  model,
  provider,
  modelId: 'test',
  isFallback,
});
const request = () =>
  new Request('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({ threadId: 11, message: 'Highest views?' }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.headroom = { allowed: true, used: 0, limit: 80 };
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('buffered chat response and provider accounting', () => {
  it('correlates request metadata and separates model/tool time from persistence without recording text', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls += 1;
        return calls < 4 ? response() : response('1248 views.');
      },
    });
    state.resolveLanes.mockReturnValue([lane(model)]);
    const id = 'a1d79f8a-9bcb-4517-8ddc-45748b9ab31d';
    const result = await POST(
      new Request('http://localhost/api/chat', {
        headers: { 'x-trellis-request-id': id },
        method: 'POST',
        body: JSON.stringify({ threadId: 11, message: 'Private conversation; never export this' }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('x-trellis-request-id')).toBe(id);
    const log = vi.mocked(console.info).mock.calls.find(([prefix]) => prefix === '[performance]')!;
    const metadata = JSON.parse(log[1] as string);
    expect(metadata.counters).toMatchObject({
      modelCalls: 4,
      historyMessages: 1,
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(metadata.stages.model.count).toBe(4);
    expect(metadata.stages.model.wallMs).toBeGreaterThan(30);
    expect(metadata.stages.tool.count).toBe(3);
    expect(metadata.stages.persistence.count).toBe(2);
    expect(metadata.stages.validation.count).toBe(1);
    expect(metadata.otherRequestMs).toBeGreaterThanOrEqual(0);
    expect(log[1]).not.toContain('Private conversation');
    expect(log[1]).not.toContain('1248 views.');
  });

  it('records the duration of a rejected model call without exporting its error', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    state.resolveLanes.mockReturnValue([
      lane(
        new MockLanguageModelV3({
          doGenerate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('Private provider response');
          },
        }),
      ),
    ]);
    expect((await POST(request())).status).toBe(500);
    const log = vi.mocked(console.info).mock.calls.find(([prefix]) => prefix === '[performance]')!;
    const metadata = JSON.parse(log[1] as string);
    expect(metadata.stages.model).toMatchObject({ count: 1, failed: 1 });
    expect(metadata.stages.model.wallMs).toBeGreaterThan(5);
    expect(metadata.outcome).toBe('error');
    expect(log[1]).not.toContain('Private provider response');
  });

  it('saves a final answer from lookup evidence with four requests and three tool calls', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [response(), response(), response(), response('1248 views.')],
    });
    state.resolveLanes.mockReturnValue([lane(model)]);
    const result = await POST(request());
    expect(await result.json()).toMatchObject({
      answer: '1248 views.',
      dropped: 0,
      toolsUsed: ['getPostsRanked', 'getPostsRanked', 'getPostsRanked'],
    });
    expect(state.appendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: 'assistant', content: '1248 views.', validation: null }),
    );
    expect(state.runs).toHaveBeenCalledWith(expect.objectContaining({ calls: 4, status: 'ok' }));
    expect(model.doGenerateCalls.at(-1)?.toolChoice).toEqual({ type: 'none' });
  });

  it.each(['', '99999 views.'])(
    'saves distinct handling and validation for output %j',
    async (text) => {
      state.resolveLanes.mockReturnValue([
        lane(new MockLanguageModelV3({ doGenerate: response(text) })),
      ]);
      const result = await POST(request());
      const body = await result.json();
      expect(body.dropped).toBe(text ? 1 : 0);
      expect(body.answer).toContain(text ? "I've dropped it" : "couldn't generate an answer");
      expect(state.appendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ validation: text ? { dropped: expect.any(Array) } : null }),
      );
      expect(console.info).toHaveBeenCalledWith(
        '[chat.response]',
        expect.objectContaining({
          emptyBeforeValidation: !text,
          outcome: text ? 'validation_removed' : 'empty_model_response',
        }),
      );
    },
  );

  it('records all attempted primary requests before a quota error and uses the fallback lane', async () => {
    let calls = 0;
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        if (++calls < 4) return response();
        throw Object.assign(new Error('rate limit'), { statusCode: 429 });
      },
    });
    const fallback = new MockLanguageModelV3({
      doGenerate: response('Views were never measured.'),
    });
    state.resolveLanes.mockReturnValue([lane(primary), lane(fallback, 'groq', true)]);
    const result = await POST(request());
    expect(await result.json()).toMatchObject({
      answer: 'Views were never measured.',
      via: 'groq:test',
    });
    expect(state.runs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: 'google', calls: 4, status: 'error' }),
    );
    expect(state.runs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: 'groq', calls: 1, status: 'ok' }),
    );
    expect(calls).toBe(4);
  });

  it('respects the remaining daily allowance', async () => {
    state.headroom = { allowed: true, used: 79, limit: 80 };
    const model = new MockLanguageModelV3({
      doGenerate: response('I need more evidence to rank your posts.'),
    });
    state.resolveLanes.mockReturnValue([lane(model)]);
    expect((await POST(request())).status).toBe(200);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: 'none' });
    expect(state.runs).toHaveBeenCalledWith(expect.objectContaining({ calls: 1 }));
  });

  it('preserves the provider-limit response when every lane is exhausted', async () => {
    state.headroom = { allowed: false, used: 80, limit: 80 };
    state.resolveLanes.mockReturnValue([lane(new MockLanguageModelV3())]);
    const result = await POST(request());
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: 'quota' });
    expect(state.runs).not.toHaveBeenCalled();
  });
});
