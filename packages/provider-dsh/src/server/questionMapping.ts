import type { SdkUserQuestionRequest, SdkUserQuestionResult } from "@deepseek-ai/dsh-sdk-client";

/**
 * T3 answers are an opaque record. Accept only strings or string arrays and
 * match selected labels against the exact choices exposed by DSH.
 * Fail closed instead of accidentally treating malformed data as an answer.
 */
export function mapT3AnswersToDsh(
  questions: SdkUserQuestionRequest["questions"],
  answers: Readonly<Record<string, unknown>> | undefined,
): SdkUserQuestionResult {
  if (!answers) return { cancelled: true };
  const results: Array<{ id: string; selected: string[]; custom?: string }> = [];
  for (const question of questions) {
    const raw = answers[question.id];
    if (raw === undefined) return { cancelled: true };
    const entries = typeof raw === "string"
      ? [raw]
      : Array.isArray(raw) && raw.every((entry) => typeof entry === "string")
        ? raw
        : null;
    if (entries === null || entries.length === 0 || entries.length > 20) return { cancelled: true };
    const allowed = new Set((question.options ?? []).map((choice) => choice.label));
    const selected = [...new Set(entries.filter((entry) => allowed.has(entry)))];
    const custom = entries.filter((entry) => !allowed.has(entry)).join("\n").trim();
    if (!question.multiSelect && selected.length > 1) return { cancelled: true };
    if (custom.length > 2000 || (!custom && selected.length === 0)) return { cancelled: true };
    results.push({ id: question.id, selected, ...(custom ? { custom } : {}) });
  }
  return { answers: results };
}
