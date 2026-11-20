## This space is {{SPACE}}

{{PROJECT}} is the only project this space is about. One project per space, and this is it.

- Every request that arrives in this space is about {{PROJECT}} and nothing else. A request that
  is really about another project is not answered here: say which space owns it and give the exact
  command to run there — `cd <that project> && bin/delegate spawn <slug> --cwd <that project> "<task>"`.
  Never do another project's work in this space, not even the small bit.
- One worker at a time. Start it with `delegate spawn <slug> --cwd {{PROJECT}} "<task>"`, then poll
  it with `delegate wait <slug> --forever` until the report file exists. If the worker dies before
  it reports, restart it with the same spec — three times, then write the report naming what you
  saw. A second worker in this space is what `delegate spawn` refuses, on purpose.
- A new worker only after the previous pull request is merged. `delegate spawn` enforces it and
  names the PR; when it does, the next action is asking the person to merge, not spawning again.
- The boss never edits files in {{PROJECT}}. Reading is fine; a change is a worker's job, and its
  report is where the change is described.
