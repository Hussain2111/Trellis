import { generateText } from 'ai';
import { respond } from '@/lib/api/respond';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { modelRuns } from '@/lib/db/schema';
import { chatTools } from '@/lib/chat/tools';
import { count, measure, requestId, startStage } from '@/lib/performance/server';
import {
  appendMessage,
  buildSystemPrompt,
  ledgerFor,
  selfAccountId,
  findThread,
  threadMessages,
  titleThread,
} from '@/lib/chat/threads';
import {
  asQuotaError,
  checkHeadroom,
  maxStepsFor,
  quotaCaps,
  resolveLanes,
} from '@/lib/model/provider';
import {
  chatGenerationOptions,
  chatStepDiagnostic,
  validateChatAnswer,
} from '@/lib/chat/generation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({
  threadId: z.number().int(),
  message: z.string().min(1).max(4000),
});

/**
 * Buffered, validated, then rendered — deliberately not streamed.
 *
 * The rule is that an unbacked figure is DROPPED, not caveated. You cannot
 * un-send a token, so streaming the answer text and validating afterwards would
 * mean either showing a wrong number briefly or retracting it visibly. Both
 * defeat the point. Tool progress could stream; the answer cannot.
 */
export async function POST(request: Request): Promise<Response> {
  const handler = async () => {
    const finishPreflight = startStage('preflight');
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: 'bad request' }, { status: 400 });
    const { threadId, message } = parsed.data;

    const accountId = await selfAccountId();
    if (!accountId) {
      return Response.json(
        { error: 'no_account', message: 'No account is set up yet. Run the sync first.' },
        { status: 409 },
      );
    }

    // Read off the thread row, not off the request. Which note a conversation
    // came from is a property of the conversation, and the client has no business
    // asserting it on every turn — and a thread id that belongs to nobody is
    // answered here rather than several queries later as a constraint violation.
    const thread = await findThread(accountId, threadId);
    if (!thread) {
      return Response.json(
        { error: 'no_thread', message: 'That conversation no longer exists.' },
        { status: 404 },
      );
    }
    const sourceCardId = thread.sourceCardId;

    await appendMessage({ threadId, role: 'user', content: message });
    const history = await threadMessages(threadId);
    count('historyMessages', history.length);
    // Titles the thread from the first thing the user says, and only if it has no
    // title — a thread opened from a note was already named after the note.
    if (history.filter((m) => m.role === 'user').length === 1) await titleThread(threadId, message);

    const caps = quotaCaps();

    let lanes;
    try {
      lanes = resolveLanes();
    } catch (error) {
      return Response.json(
        {
          error: 'model_unavailable',
          message: error instanceof Error ? error.message : 'no model',
        },
        { status: 503 },
      );
    }

    const system =
      (await buildSystemPrompt(accountId)) +
      (sourceCardId
        ? [
            '',
            '',
            // The id is an instruction to the tool, never a name for the note.
            // Naming it in this sentence is what produced answers opening
            // "Dashboard note 1 (generated today) highlights…" — a preamble
            // about where the conversation started, in front of the answer
            // that was actually asked for.
            `This conversation was opened from a note on the dashboard. Call getInsightCard with cardId ${sourceCardId} before answering, so its figures come back as data you may restate.`,
            'Do NOT open with a preamble about the note, its number, or when it was generated. Answer the question that was asked. Mention the note only where it bears on the answer, and then as "the note you opened" — it has no number the reader can see.',
          ].join('\n')
        : '');

    const tools = chatTools(accountId);
    const messages = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    /**
     * Walk the lanes. A lane out of requests is a reason to try the next one,
     * not a reason to fail the question — which is the entire point of
     * configuring MODEL_FALLBACK, and was not what it did before: the fallback
     * was reached only when the primary could not be BUILT.
     *
     * Every limit belongs to a provider, so the ledger is scoped to one too. A
     * fresh provider starts with a fresh allowance rather than inheriting the
     * exhausted one's counter.
     */
    let lastRefusal: { message: string; retryAfterSeconds?: number } | null = null;

    for (const model of lanes) {
      const headroom = await checkHeadroom('chat', ledgerFor(model.provider), caps);
      if (!headroom.allowed) {
        lastRefusal = {
          message: headroom.retryAfterSeconds
            ? `${headroom.reason} ${waitPhrase(headroom.retryAfterSeconds)}`
            : (headroom.reason ?? 'No allowance left.'),
          retryAfterSeconds: headroom.retryAfterSeconds,
        };
        continue;
      }

      const started = Date.now();
      let attemptedCalls = 0;
      const modelTimers = new Map<string, (failed?: boolean) => void>();
      const toolTimers = new Map<string, (failed?: boolean) => void>();
      const maxSteps = Math.min(maxStepsFor(caps), headroom.limit - headroom.used);
      try {
        finishPreflight();
        const result = await generateText({
          model: model.model,
          system,
          messages,
          tools,
          // Every step is another provider request, so the ceiling is derived
          // from the per-minute limit rather than picked. A fixed 8 blew a
          // 5-a-minute budget from inside a single call, where no pre-flight
          // check can reach.
          ...chatGenerationOptions<typeof tools>(maxSteps, system),
          onLanguageModelCallStart: ({ callId }) => {
            attemptedCalls += 1;
            count('modelCalls');
            modelTimers.set(callId, startStage('model'));
          },
          onLanguageModelCallEnd: ({ callId, usage }) => {
            modelTimers.get(callId)?.();
            modelTimers.delete(callId);
            count('inputTokens', usage.inputTokens ?? 0);
            count('outputTokens', usage.outputTokens ?? 0);
          },
          onToolExecutionStart: ({ toolCall }) => {
            toolTimers.set(toolCall.toolCallId, startStage('tool'));
          },
          onToolExecutionEnd: ({ toolCall, toolOutput }) => {
            toolTimers.get(toolCall.toolCallId)?.(toolOutput.type === 'tool-error');
            toolTimers.delete(toolCall.toolCallId);
          },
          onStepEnd: (step) => {
            console.info('[chat.step]', {
              requestId: requestId(),
              threadId,
              provider: model.provider,
              ...chatStepDiagnostic(step),
            });
          },
          // The SDK's default is three attempts. On a quota error that spends
          // three of the five requests a minute allows, on a call that could not
          // have succeeded — so retrying is handled here, by not doing it.
          maxRetries: 0,
          temperature: 0.4,
        });

        // Everything the tools actually returned this turn. This — and only
        // this — is what the model's numbers are allowed to be drawn from.
        const evidence = result.steps.flatMap((step) =>
          step.toolResults.map((r) => (r as { output?: unknown }).output),
        );

        const finishValidation = startStage('validation');
        const { answer, dropped, outcome, emptyBeforeValidation, validatedTextLength } =
          validateChatAnswer(result.text, evidence);
        finishValidation();
        console.info('[chat.response]', {
          requestId: requestId(),
          threadId,
          provider: model.provider,
          steps: result.steps.length,
          finishReason: result.finishReason,
          textLength: result.text.length,
          emptyBeforeValidation,
          validatedTextLength,
          droppedCount: dropped.length,
          outcome,
        });

        await measure('persistence', () =>
          appendMessage({
            threadId,
            role: 'assistant',
            content: answer,
            toolCalls: result.steps.flatMap((step) => step.toolCalls.map((c) => c.toolName)),
            validation: dropped.length > 0 ? { dropped } : null,
          }),
        );

        await measure('persistence', () =>
          db()
            .insert(modelRuns)
            .values({
              accountId,
              purpose: 'chat',
              provider: model.provider,
              model: model.modelId,
              promptTokens: result.usage?.inputTokens ?? null,
              completionTokens: result.usage?.outputTokens ?? null,
              status: 'ok',
              calls: result.steps.length,
              durationMs: Date.now() - started,
            }),
        );

        return Response.json({
          answer,
          // Surfaced rather than hidden: if the validator had to remove
          // something, that is worth knowing about the model, not just about
          // the answer.
          dropped: dropped.length,
          toolsUsed: result.steps.flatMap((step) => step.toolCalls.map((c) => c.toolName)),
          // Which lane answered. A fallback answering is not a failure, but it
          // is worth being able to see rather than having to infer.
          via: model.isFallback ? `${model.provider}:${model.modelId}` : undefined,
        });
      } catch (error) {
        for (const finish of modelTimers.values()) finish(true);
        for (const finish of toolTimers.values()) finish(true);
        const quota = asQuotaError(error);

        await measure('persistence', () =>
          db()
            .insert(modelRuns)
            .values({
              accountId,
              purpose: 'chat',
              provider: model.provider,
              model: model.modelId,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
              // A rejected call still reached the provider and still counted
              // against the limit there. Recording it as zero would let the
              // ledger drift below what is actually being enforced, which is how
              // a guard gets quietly overrun.
              calls: Math.max(1, attemptedCalls),
              durationMs: Date.now() - started,
            }),
        );

        if (quota) {
          lastRefusal = {
            message: `${model.provider} is over its request limit. ${waitPhrase(quota.retryAfterSeconds)}`,
            retryAfterSeconds: quota.retryAfterSeconds,
          };
          continue;
        }

        return Response.json(
          { error: 'failed', message: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }

    // Every lane refused. A quota refusal is not a failure of this app and
    // clears by waiting, so it says so, and says when.
    return Response.json(
      {
        error: 'quota',
        message:
          lastRefusal?.message ??
          'No model is available at the moment.' +
            (lanes.length === 1
              ? ' Setting MODEL_FALLBACK to a different provider would let this fall through instead of stopping.'
              : ''),
        retryAfterSeconds: lastRefusal?.retryAfterSeconds,
      },
      {
        status: 429,
        ...(lastRefusal?.retryAfterSeconds
          ? { headers: { 'retry-after': String(lastRefusal.retryAfterSeconds) } }
          : {}),
      },
    );
  };
  return respond(handler, { route: '/api/chat', request });
}

/** Seconds are the right unit for a minute and the wrong one for eleven hours. */
function waitPhrase(seconds: number): string {
  if (seconds < 120) return `Try again in about ${seconds} seconds.`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `Try again in about ${minutes} minutes.`;
  const hours = Math.round(minutes / 60);
  return `The next slot frees in about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
}
