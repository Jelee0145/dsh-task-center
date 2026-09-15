# @lyzi_nya/dsh-task-center

Durable to-do and scheduled-task engine for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A task owns one lifecycle state and any number of **execution records**. A recurring task that fires
again never overwrites the outcome of an earlier execution, so "the agent finished run 3, the user has
not accepted it yet" survives run 4 starting. State is written to disk atomically, so a restart no
longer loses the list.

## Status

This is version `0.1.0`, extracted from a working prototype. Be precise about what that means:

| Part | State |
|---|---|
| `domain`, `schedule`, `store`, `scheduler`, `persistence` | Complete. `tsc --strict` clean. |
| `index.ts` — engine wiring, Cordis plugin, 5 model tools | Complete and typechecked; the host seam is structural, see below. |
| `runner.ts` — agent execution | Complete. Creates or resumes the session a task names, and delivers the prompt. |
| `client.ts`, `ui.ts` — browser half | Complete. Five surfaces: home dock, session-header button, sidebar panel, main panel, drawer. |

## Install

```sh
npm install @lyzi_nya/dsh-task-center
```

Zero runtime dependencies. Node `>=22.19`.

## Use it

```ts
import { createTaskCenter } from 'dsh-task-center'

const center = createTaskCenter({
  persistence: { rootDir: '/var/lib/dsh-tasks' },
})

await center.start()                       // load durable state, then arm the timer
const task = center.store.createTask({ title: 'ship it' })
center.startNow(task.id)                   // execute once, without changing the plan
await center.dispose()                     // flushes any pending write
```

Mounted as a Cordis plugin, `apply` builds the runner itself, so the row needs no config:

```yaml
- id: task-center
  name: '@lyzi_nya/dsh-task-center'
```

`createTaskCenter` wires one write-through path and one execution path: every store mutation queues the
new state for persistence **and** wakes the scheduler, so a caller never has to remember either.

## Host integration

The package imports nothing from `@deepseek-ai/*`: a DSH profile resolves its own harness packages,
not this one's, so a bare `@deepseek-ai/dsh-tools` import fails to resolve at load. The host half
therefore reaches the harness at runtime, through `ctx.get(name)` and structural interfaces:

- `TaskCenterHostContext` — `tools.register`, `effect`, `get`, `inject`. Satisfied by a Cordis context.
- `TaskCenterRunner` — deliver a prompt to the right session. **`apply` builds the real one**; supply
  your own only to embed the engine outside a harness.

`apply(ctx, config)` registers the five model tools, owns the engine for the calling fiber, serves the
browser bridge on `webServer`, and builds a runner over three services:

| Service | Used for |
|---|---|
| `agents` | `create` a session for `runIn: 'new-session'`, or `get`/`resume` the one a task names |
| `agentPresets` | resolve and mount the preset a new session runs under |
| `agentDefaultModel` | the provider and model route for a new session |

Two harness conventions are reproduced in place rather than imported, because neither is reachable
from this package:

- **Tool parameters.** The harness's `defineTool` compiles a parameter DSL into an object-rooted JSON
  Schema. A definition registered without that step reaches the model as the raw DSL map — no `type`,
  no `properties` — which is not a usable tool schema. `compileParameters` performs the compilation.
- **The user message.** `createTaskMessage` produces the same value `createUserMessage` does:
  `{ id, role: 'user', content, source }`, with a fresh UUID identity.

## Task and execution model

```
Task { id, title, note, state: 'open'|'paused'|'done', runIn, schedule, runs[], … }
Run  { id, trigger: 'manual'|'schedule', status: 'running'|'completed'|'accepted'|'failed', … }
```

The status a user sees is **derived**, not stored:

```
done → running → awaiting_acceptance → failed (newest run) → paused → scheduled → pending
```

**Only the user confirms completion.** `task_update` can settle one execution as `completed` or
`failed`; the two user-only outcomes (`accepted`, `done`) are unreachable through every model tool.
That is enforced in the operation, not in the schema text.

## Scheduling

Five plan kinds, each normalized to `{ enabled, nextFireAt, spec }`:

| Kind | Meaning |
|---|---|
| `after` | N minutes from creation |
| `at` | one absolute instant |
| `daily` | a wall-clock time every day |
| `weekly` | a weekday plus a wall-clock time |
| `every` | a fixed interval, anchored at creation |

`every` and the calendar kinds advance to the **first future occurrence** after a fire — a missed
backlog collapses into one execution at the latest occurrence rather than a replay.

The timer arms the exact delay when it is within the segment bound and re-arms once per segment beyond
it, re-reading the wall clock on every wake, so a suspend/resume or a clock jump cannot drift.

## Persistence

`state.json`, versioned, written atomically (temp file in the same directory, then rename). Writes are
coalesced and flushed on dispose. Reads tolerate a missing file, an empty file, and malformed JSON
(the bad file is backed up, not deleted); an **unknown future version fails loud** rather than
silently discarding data.

Root resolution: an explicit `rootDir` option, else `$DSH_TASK_CENTER_HOME`, else `~/.dsh/tasks`.

## Known limitations

- **Calendar rules use a captured fixed UTC offset.** Daylight-saving transitions are not modelled; a
  `daily` rule created in a DST-observing zone keeps the offset it was created with.
- **`every` never replays a backlog** — by design, but it means a long outage yields one execution.
- **Nothing asserts the host seam at build time.** The host half calls service methods by name, so a
  harness that renames one fails at execution, not at `tsc`. The failure is loud: the execution is
  recorded as `failed` with the error text.
- **A cold target session is resumed, not woken.** Delivering to a session that is not running calls
  `agents.resume` first, which is the only path DSH offers.
- **A scheduled execution records the raw title as its prompt** while delivering the framed one. Only
  the manual path records the exact delivered text.
- Reasonable for a single host process; there is no cross-process lock, so two processes sharing one
  storage root would fight over `state.json`.

## Development

```sh
npm run typecheck   # tsc --noEmit, zero errors
npm test            # 111 unit tests
npm run build       # emits lib/
```

## License

MIT
