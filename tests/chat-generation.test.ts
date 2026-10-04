import { describe, expect, it } from 'vitest';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import {
  chatGenerationOptions,
  chatStepDiagnostic,
  validateChatAnswer,
} from '../lib/chat/generation';
import { checkHeadroom, maxStepsFor } from '../lib/model/provider';

const system = 'Only state statistics returned by tools.';
const tools = {
  getPostsRanked: tool({
    inputSchema: z.object({}),
    execute: async () => ({ posts: [{ caption: 'New reel', views: 1248 }] }),
  }),
};
function response(
  content: LanguageModelV3GenerateResult['content'],
  reason: 'stop' | 'tool-calls',
): LanguageModelV3GenerateResult {
  return {
    content,
    finishReason: { unified: reason, raw: reason },
    warnings: [],
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
  };
}
const lookup = (index: number) =>
  response(
    [{ type: 'tool-call', toolCallId: `lookup-${index}`, toolName: 'getPostsRanked', input: '{}' }],
    'tool-calls',
  );

describe('chat lookup and answering budget through the installed SDK', () => {
  it('reproduces an empty successful run when every allowed step requests tools', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [lookup(0), lookup(1), lookup(2), lookup(3)],
    });
    const result = await generateText({
      model,
      tools,
      prompt: 'Which new post got the highest views?',
      stopWhen: stepCountIs(4),
    });
    expect(result.steps).toHaveLength(4);
    expect(result.finishReason).toBe('tool-calls');
    expect(result.text).toBe('');
    expect(validateChatAnswer(result.text, []).dropped).toEqual([]);
  });

  it.each([2, 4, 8])(
    'reserves the last of %i requests and answers from earlier evidence',
    async (budget) => {
      const diagnostics: ReturnType<typeof chatStepDiagnostic>[] = [];
      const model: MockLanguageModelV3 = new MockLanguageModelV3({
        doGenerate: async (options) => {
          const index = model.doGenerateCalls.length - 1;
          if (index < budget - 1) return lookup(index);
          expect(options.tools).toBeUndefined();
          expect(options.toolChoice).toEqual({ type: 'none' });
          expect(JSON.stringify(options.prompt)).toContain('1248');
          expect(JSON.stringify(options.prompt)).toContain('final answering step');
          return response([{ type: 'text', text: 'Your new reel had 1248 views.' }], 'stop');
        },
      });
      let attempts = 0;
      const result = await generateText({
        model,
        tools,
        system,
        prompt: 'Which new post got the highest views?',
        ...chatGenerationOptions<typeof tools>(budget, system),
        maxRetries: 0,
        onLanguageModelCallStart: () => {
          attempts += 1;
        },
        onStepEnd: (step) => {
          diagnostics.push(chatStepDiagnostic(step));
        },
      });
      const evidence = result.steps.flatMap((step) => step.toolResults.map((r) => r.output));
      expect(validateChatAnswer(result.text, evidence)).toMatchObject({
        answer: 'Your new reel had 1248 views.',
        outcome: 'answer',
        dropped: [],
      });
      expect(result.steps.flatMap((step) => step.toolCalls)).toHaveLength(budget - 1);
      expect(model.doGenerateCalls).toHaveLength(budget);
      expect(attempts).toBe(budget);
      expect(diagnostics[0]).toEqual({
        stepNumber: 1,
        finishReason: 'tool-calls',
        toolNames: ['getPostsRanked'],
        textLength: 0,
      });
      expect(diagnostics.at(-1)).toMatchObject({
        stepNumber: budget,
        finishReason: 'stop',
        toolNames: [],
      });
      expect(JSON.stringify(diagnostics)).not.toContain('1248');
    },
  );

  it('allows an early answer without spending the reserved request', async () => {
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doGenerate: [lookup(0), response([{ type: 'text', text: '1248 views.' }], 'stop')],
    });
    const result = await generateText({
      model,
      tools,
      system,
      prompt: 'Highest views?',
      ...chatGenerationOptions<typeof tools>(4, system),
    });
    expect(result.steps).toHaveLength(2);
  });

  it('counts successful lookups and a rejected final request without SDK retries', async () => {
    let attempts = 0;
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
      doGenerate: async () => {
        if (model.doGenerateCalls.length < 4) return lookup(model.doGenerateCalls.length);
        throw new Error('rate limit');
      },
    });
    await expect(
      generateText({
        model,
        tools,
        system,
        prompt: 'Highest views?',
        ...chatGenerationOptions<typeof tools>(4, system),
        maxRetries: 0,
        onLanguageModelCallStart: () => {
          attempts += 1;
        },
      }),
    ).rejects.toThrow('rate limit');
    expect(attempts).toBe(4);
    expect(model.doGenerateCalls).toHaveLength(4);
  });

  it('stays within headroom and the configured per-minute allowance', async () => {
    const caps = { dailyCalls: 100, reservedForCards: 20, callsPerMinute: 5 };
    const headroom = await checkHeadroom(
      'chat',
      { callsToday: async () => 0, callsLastMinute: async () => 1 },
      caps,
    );
    expect(headroom.allowed).toBe(true);
    expect(maxStepsFor(caps) + headroom.used).toBeLessThanOrEqual(caps.callsPerMinute);
    const tight = await checkHeadroom(
      'chat',
      {
        callsToday: async (purpose) => (purpose === 'chat' ? 79 : 0),
        callsLastMinute: async () => 0,
      },
      caps,
    );
    const budget = Math.min(maxStepsFor(caps), tight.limit - tight.used);
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        expect(options.tools).toBeUndefined();
        return response(
          [{ type: 'text', text: 'I do not have enough evidence to rank your posts.' }],
          'stop',
        );
      },
    });
    await generateText({
      model,
      tools,
      system,
      prompt: 'Highest views?',
      ...chatGenerationOptions<typeof tools>(budget, system),
    });
    expect(model.doGenerateCalls.length + tight.used).toBe(tight.limit);
  });
});

describe('empty output and number validation', () => {
  it.each(['', '  \n '])('labels empty output without claiming statistics were removed', (text) => {
    expect(validateChatAnswer(text, [])).toMatchObject({
      outcome: 'empty_model_response',
      emptyBeforeValidation: true,
      dropped: [],
    });
    expect(validateChatAnswer(text, []).answer).not.toContain('figure');
  });
  it('reports rejected statistics and preserves the existing refusal', () => {
    const result = validateChatAnswer('Your post had 99999 views.', [{ views: 1248 }]);
    expect(result).toMatchObject({ outcome: 'validation_removed', emptyBeforeValidation: false });
    expect(result.dropped[0]?.figures).toEqual([99999]);
    expect(result.answer).toContain("I've dropped it");
  });
  it('keeps supported text while removing an unsupported sentence', () => {
    expect(
      validateChatAnswer('Your reel had 1248 views. Your photo had 99999 views.', [{ views: 1248 }])
        .answer,
    ).toBe('Your reel had 1248 views.');
  });
  it('preserves a missing-data explanation', () => {
    const answer = 'Views were never measured for these posts, so I cannot rank them.';
    expect(validateChatAnswer(answer, [{ views: null, missing: 'never_sampled' }])).toMatchObject({
      answer,
      outcome: 'answer',
      dropped: [],
    });
  });
});
