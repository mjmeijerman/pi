---
name: questionnaire
description: Run an interactive multiple-choice questionnaire with the user. Use when asked to do a quiz (e.g. "quiz me about music"), a trivia/test session, or when a task has unresolved design decisions and clarifying choices should be presented to the user before continuing.
---

# Questionnaire Mode

Run structured, interactive questionnaires. Two modes:

## Mode 1: Quiz / Trivia

Trigger: user asks for a quiz, test, or "questionnaire over <topic>".

Rules:
1. **Set up**: Confirm topic, difficulty (easy/medium/hard), and number of questions (default 10 if not specified). Ask only if the user hasn't specified.
2. **One question at a time**. Wait for the user's answer before moving on.
3. **Format** every question exactly like this (options are numbered 1/2/3/..., NEVER letters):

```
Vraag <n>/<total> (<difficulty>): <question>

  1) <option>
  2) <option>
  3) <option>
  4) <option>

Antwoord? (1/2/3/4 of vrije tekst)
```

Add no explicit "anders" option in quiz mode — free text is already allowed implicitly.

4. **Options**: 3–4 plausible options, at most one correct. No "alle bovenstaande" unless genuinely correct.
5. **Scoring**: Immediately after the answer, respond with:
   - ✅ Correct! + short explanation (1–2 sentences of interesting context)
   - ❌ Helaas, het juiste antwoord was <n>) <x> + short explanation
   - Running score, e.g. `Score: 3/5`
6. **Finish**: After the last question, give a final summary: total score, which questions were missed, and a one-line verdict based on performance.
7. If the user answers in free text, accept it if clearly correct; otherwise count it wrong unless they clearly meant the right option.
8. If the user says "volgende" / "next" without answering, count it as a skip (no point) and continue.

## Mode 2: Clarifying design / task questions

Trigger: user gives a build task with open decisions, or explicitly asks to "present choices", "stel me keuzes", "wat moet ik kiezen?".

Rules:
1. Identify **only** the decisions that materially affect the outcome. Do NOT ask about trivial details — pick sensible defaults for anything minor and mention them at the end.
2. Max **3–5 questions per round** of one round-trip is ideal; each question must be multiple choice with concrete, mutually exclusive options and a **clearly marked recommended default** (so the user can just say "defaults" and you proceed).
3. **Format** each decision like this (options numbered, with a mandatory free-text "anders" option):

```
Kies een optie per vraag (of zeg "default" voor alles):

 1. <Topic>, bijv. framework
    1) <option A> — <one-line trade-off> ⭐ (aanbevolen)
    2) <option B> — <one-line trade-off>
    3) <option C> — <one-line trade-off>
    0) Anders — typ zelf de gewenste optie
```

4. If the user says "defaults" / "standaard" / "jij kiest": use the ⭐ option for all unanswered questions and proceed.
5. If the user picks **0) / anders** or gives a free-text answer that isn't one of the options: adopt it if reasonable, otherwise briefly ask a follow-up.
6. After the answers, **summarize the chosen stack/decisions in one compact block** and then start the work. This summary doubles as the spec of record for the session.

## General style

- Match the user's language (Dutch if they write Dutch, English if they write English).
- Keep option text short — one line per option.
- Never block on more than 5 open questions without making progress.
- When in Mode 2, the moment all questions are answered (or defaults accepted), immediately do the work — no further confirmation needed.
