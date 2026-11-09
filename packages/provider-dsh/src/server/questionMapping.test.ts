import { describe, expect, it } from "vite-plus/test";
import { mapT3AnswersToDsh } from "./questionMapping.ts";

const questions = [
  { id: "choice", question: "Pick one", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
  { id: "reason", question: "Why?", options: [] },
];

describe("DSH native user question conversion", () => {
  it("preserves selected labels and custom input", () => {
    expect(mapT3AnswersToDsh(questions, { choice: "A", reason: "Because" })).toEqual({
      answers: [
        { id: "choice", selected: ["A"] },
        { id: "reason", selected: [], custom: "Because" },
      ],
    });
  });
  it("denies an incomplete or malformed answer", () => {
    expect(mapT3AnswersToDsh(questions, { choice: "A" })).toEqual({ cancelled: true });
    expect(mapT3AnswersToDsh(questions, { choice: 4, reason: "Because" })).toEqual({ cancelled: true });
    expect(mapT3AnswersToDsh(questions, undefined)).toEqual({ cancelled: true });
  });
  it("rejects excessive free text and invalid single-select responses", () => {
    expect(mapT3AnswersToDsh([questions[0]!], { choice: ["A", "B"] })).toEqual({ cancelled: true });
    expect(mapT3AnswersToDsh([questions[1]!], { reason: "a".repeat(2001) })).toEqual({ cancelled: true });
  });
});
