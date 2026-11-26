import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { nextReq, text } from "../io.mjs";
import { checklistThreads } from "../session.mjs";

export function questionTools(s, c) {
  const { T, tid, live, hitLimit, requestTool, send } = c;
  const askQuestions = (qs) => {
    {
      const lim = hitLimit("any");
      if (lim) return lim;
    }
    // turnId ties the form to the reply it belongs to, so the UI shows it once, as the question
    // form, instead of also showing any streamed text for that turn. item_id counts only inside a
    // checklist grill.
    const checklist = checklistThreads.has(s.key);
    const questions = qs.map((q, i) => ({
      id: q.id || `q${i + 1}`,
      question: q.question,
      choices: q.choices,
      // A recommended value that is not one of the choices is dropped rather than failing the turn.
      ...(q.recommended && q.choices.includes(q.recommended) ? { recommended: q.recommended } : {}),
      ...(q.context ? { context: q.context } : {}),
      ...(checklist && q.item_id ? { itemId: q.item_id } : {}),
    }));
    send({ type: "questions", id: `q${nextReq()}`, turnId: tid(), questions });
    // Anything the model writes after asking is noise ("the question is above"): drop it, so the
    // turn is the question form and nothing else.
    if (T()) T().questionAsked = true;
    // Observed live: without a firm stop here the model sometimes kept going and wrote a guessed
    // "[Answer] ..." itself. The real answer only ever comes as the user's next message.
    return {
      content: [
        {
          type: "text",
          text: "The questions are now shown to the user as buttons. END YOUR TURN NOW: write nothing more, do not guess or state an answer. The user's real answers will arrive as their next message.",
        },
      ],
    };
  };
  // Kept for older threads and models that still call it: a batch of one.
  const askQuestionTool = tool(
    "ask_question",
    "Ask the user exactly one multiple-choice question. Prefer ask_questions. Present 2-5 short, neutral, concrete " +
      "choices. The question is shown to the user with buttons, so do not also write it as text.",
    { question: z.string(), choices: z.array(z.string()).min(2).max(5) },
    async (args) => askQuestions([args]),
  );
  const askQuestionsTool = tool(
    "ask_questions",
    "Ask the user 1-4 multiple-choice questions at once (used for /grill-me), shown as one form with buttons, so do " +
      "not also write them as text. Each has 2-5 short, neutral, concrete choices. Wait for the answers as the next " +
      "message before asking more.",
    {
      questions: z
        .array(
          z.object({
            id: z.string().optional(),
            question: z.string(),
            choices: z.array(z.string()).min(2).max(5),
            recommended: z.string().optional().describe("Your recommended choice; must equal one of the choices"),
            context: z.string().optional().describe("Short background for the question, shown under it"),
            item_id: z.string().optional().describe("Only in /grill-me checklist: the [item_id] this question answers. Omit otherwise."),
          }),
        )
        .min(1)
        .max(4),
    },
    async (args) => askQuestions(args.questions),
  );

  return [askQuestionTool, askQuestionsTool];
}
