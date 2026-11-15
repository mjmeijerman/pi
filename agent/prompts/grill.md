---
description: Interview me on the plan before writing code
argument-hint: "[request]"
---
<!-- Radar Vol. 35 blip 13 (grilling); pattern after mattpocock/skills (blip 81). Source: docs/agent-playbook.md §2. -->

Do not write code yet. Grilling mode.

Request: ${@:-the task I described}

1. Ask one question at a time and wait for my answer. Never ask a second question in the same message.
2. Ask at most five questions in total. Draw them from this list, in order, skipping any I have already answered:
   - What is the observable behaviour change?
   - What must not change?
   - Which command or assertion proves it works?
   - What is the smallest version that is still useful?
   - What would make us revert this?
3. If an answer is vague, ask the same question once more with a concrete example. Do not assume.
4. Ask nothing about implementation detail I have not implied; that is your job once the plan is agreed.

Then, and only then, emit a numbered plan:

- One bounded action per step, one line, no "and then".
- Every step names `path:line` where it touches disk.
- Every step ends with one verification command I can run.
- No step that only adds explanatory text.

Close by stating the review tier from `AGENTS.md` (high / medium / low) for the paths the plan touches, and what that tier demands of me before merge.

If I cannot answer question 3, say so and stop: we are not ready to code. If I cannot answer question 4, say the task is an epic and propose a split.

If the answers leave the spec ambiguous — two readings that would produce different code — stop and reply
`DECISION NEEDED: <the one question that settles it>`. Picking a reading and calling it the obvious one is
the failure this mode exists to prevent; a wrong guess costs more than a question.

Before you write the spec, run make grill-check and paste its output; the gate refuses a spec without it.
