import { describe, expect, it } from 'vitest';
import { generateText, tool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { chatGenerationOptions, validateChatAnswer } from '../lib/chat/generation';

const tools = {
  getPostsRanked: tool({ inputSchema: z.object({}), execute: async () => ({ views: 1248 }) }),
};
type GoogleRequest = {
  contents: unknown[];
  tools?: unknown[];
  toolConfig?: { functionCallingConfig?: { mode?: string } };
};

/** Exercise real Google request serialization without a key or live provider call. */
function googleStub() {
  const requests: GoogleRequest[] = [];
  const google = createGoogleGenerativeAI({
    apiKey: 'test-only',
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as GoogleRequest;
      requests.push(body);
      const noCalls = body.toolConfig?.functionCallingConfig?.mode === 'NONE';
      return Response.json({
        candidates: [
          {
            content: {
              role: 'model',
              parts: noCalls
                ? [{ text: 'Your new reel had 1248 views.' }]
                : [
                    {
                      functionCall: { name: 'getPostsRanked', args: {} },
                      thoughtSignature: 'test-signature',
                    },
                  ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      });
    },
  });
  return { model: google('gemini-3.6-flash'), requests };
}

describe('Google final-answer request serialization', () => {
  it('reproduces the missing NONE configuration when all definitions are removed', async () => {
    const { model, requests } = googleStub();
    const result = await generateText({
      model,
      tools,
      system: 'Answer from evidence.',
      prompt: 'Highest views?',
      maxRetries: 0,
      ...chatGenerationOptions<typeof tools>(4, 'Answer from evidence.'),
      prepareStep: ({ stepNumber }) =>
        stepNumber === 3 ? { activeTools: [], toolChoice: 'none' } : undefined,
    });
    expect(requests).toHaveLength(4);
    expect(requests[3]?.tools).toBeUndefined();
    expect(requests[3]?.toolConfig).toBeUndefined();
    expect(result.text).toBe('');
    expect(result.steps.at(-1)?.toolCalls).toHaveLength(1);
  });

  it('sends mode NONE on the fourth request and validates the evidence-based answer', async () => {
    const { model, requests } = googleStub();
    const result = await generateText({
      model,
      tools,
      system: 'Answer from evidence.',
      prompt: 'Highest views?',
      maxRetries: 0,
      ...chatGenerationOptions<typeof tools>(4, 'Answer from evidence.'),
    });
    expect(requests).toHaveLength(4);
    expect(requests[0]?.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(
      requests
        .slice(0, 3)
        .every((request) => request.toolConfig?.functionCallingConfig?.mode !== 'NONE'),
    ).toBe(true);
    expect(requests[3]?.toolConfig?.functionCallingConfig?.mode).toBe('NONE');
    expect(requests[3]?.tools).toHaveLength(1);
    expect(JSON.stringify(requests[3]?.contents)).toContain('1248');
    expect(result.steps.at(-1)?.toolCalls).toEqual([]);
    const evidence = result.steps.flatMap((step) => step.toolResults.map((r) => r.output));
    expect(validateChatAnswer(result.text, evidence)).toMatchObject({
      answer: 'Your new reel had 1248 views.',
      dropped: [],
      outcome: 'answer',
    });
  });
});
