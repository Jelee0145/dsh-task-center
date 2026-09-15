# dsh-task-center

Durable to-do and scheduled-task engine for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A task owns one lifecycle state and any number of **execution records**. A recurring task that fires
again never overwrites the outcome of an earlier execution, so "the agent finished run 3, the user has
not accepted it yet" survives run 4 starting. State is written to disk atomically, so a restart no
longer loses the list.

## Status

This is version `0.1.0`, extracted from a working prototype. Be precise about what that means:

| Part | State |
|---|---|
| `domain`, `schedule`, `store`, `scheduler`, `persistence` | Complete. 105 unit tests, `tsc --strict` clean. |
| `index.ts` — engine wiring, Cordis plugin, 5 model tools | Complete and typechecked; the Cordis/DSH seam is structural, see below. |
| `client.ts` — browser-safe types and the host-call contract | Complete. |
| Browser UI (React components) | **Not included.** The prototype's UI lives in the harness as a dynamic plugin; porting it here is the next step. |
| Session creation / agent execution | **Not included.** Injected through `TaskCenterRunner`, because it is the one genuinely DSH-specific behavior. |

## Install

```sh
npm install dsh-task-center
```

Zero runtime dependencies. Node `>=22.19`.

## Use it

```ts
import { createTaskCenter } from 'dsh-task-center'

const center = createTaskCenter({
  persistence: { root: '/var/lib/dsh-tasks' },
  runner: {
    async execute(task, prompt) {
      // Create or resume the session `task.runIn` names and deliver `prompt`.
      return { sessionId: 'session-…' }
    },
  },
})

await center.start()                       // load durable state, then arm the timer
center.store.createTask({ title: 'ship it' })
await center.dispose()                     // flushes any pending write
```

`createTaskCenter` wires one write-through path and one execution path: every store mutation queues the
new state for persistence **and** wakes the scheduler, so a caller never has to remember either.

## Integration seam

The package imports nothing from `@deepseek-ai/*`. Two structural interfaces carry the whole
integration, so a real harness context satisfies them without this package depending on it:

- `TaskCenterHostContext` — `tools.register`, `effect`, `get`. Satisfied by a Cordis context.
- `TaskCenterRunner` — deliver a prompt to the right session. Supplied by the deployment.

`apply(ctx, config)` registers the five model tools and owns the engine for the calling fiber.
`config.defineTool` is where the harness's own tool factory goes.

**This is the least verified part of the package.** The structural shapes were written from the
harness's documented plugin protocol, not compiled against it, because the harness packages are not
resolvable outside a DSH installation. The engine they wrap is fully tested; treat the seam as the
thing to check first when mounting it.

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

Root resolution: an explicit `root` option, else `$DSH_TASK_CENTER_HOME`, else `~/.dsh/tasks`.

## Known limitations

- **No browser UI in this package** — see Status.
- **No session runner** — the deployment supplies it.
- **Calendar rules use a captured fixed UTC offset.** Daylight-saving transitions are not modelled; a
  `daily` rule created in a DST-observing zone keeps the offset it was created with.
- **`every` never replays a backlog** — by design, but it means a long outage yields one execution.
- **No dependency assertion for the seam** — a harness that changes its plugin protocol will not be
  caught by `tsc` here.
- Reasonable for a single host process; there is no cross-process lock, so two processes sharing one
  storage root would fight over `state.json`.

## Development

```sh
npm run typecheck   # tsc --noEmit, zero errors
npm test            # 105 unit tests
npm run build       # emits lib/
```

## License

MIT
