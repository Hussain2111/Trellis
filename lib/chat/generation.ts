import { stepCountIs, type ToolSet, type PrepareStepFunction, type StepResult } from 'ai';
import { stripUnbackedSentences } from '../validate/numbers';

/** Keep the last request inside the existing allowance for an evidence-based answer. */
export function chatGenerationOptions<TOOLS extends ToolSet>(maxSteps: number, system: string) {
  const prepareStep: PrepareStepFunction<TOOLS> = ({ stepNumber }) =>
    stepNumber >= maxSteps - 1
      ? {
          // Keep definitions so providers such as Google serialize the explicit
          // prohibition. With no definitions, Google's adapter omits mode NONE.
          toolChoice: 'none',
          system: `${system}\nThis is the final answering step. Answer the user's question using only the tool results already collected. Do not request more tools or invent figures. If the evidence is missing or insufficient, explain that plainly.`,
        }
      : stepNumber === 0
        ? { toolChoice: 'required' }
        : undefined;

  return { stopWhen: stepCountIs(maxSteps), prepareStep };
}

/** Metadata only: never include prompts, tool arguments/results, or answer text. */
export function chatStepDiagnostic<TOOLS extends ToolSet>(step: StepResult<TOOLS>) {
  return {
    stepNumber: step.stepNumber + 1,
    finishReason: step.finishReason,
    toolNames: step.toolCalls.map((call) => call.toolName),
    textLength: step.text.length,
  };
}

export function validateChatAnswer(rawText: string, evidence: unknown) {
  const emptyBeforeValidation = rawText.trim().length === 0;
  const { text, dropped } = stripUnbackedSentences(rawText, evidence);
  const outcome = emptyBeforeValidation
    ? 'empty_model_response'
    : text
      ? 'answer'
      : 'validation_removed';
  const answer =
    text ||
    (emptyBeforeValidation
      ? "I couldn't generate an answer this time. Please try again."
      : "I can't back that up from your data — every figure I was about to give you came from somewhere other than a query, so I've dropped it rather than show you a number I can't stand behind.");
  return { answer, dropped, outcome, emptyBeforeValidation, validatedTextLength: text.length };
}
