# dsh-loop

`/loop <message>` makes a dsh-TUI agent **resend that message every time it
stops** — an infinite, self-driving loop.

```text
you: /loop keep working on the task
      ↻ loop on — first round queued
      … agent works, stops …
      → "keep working on the task" is sent automatically
      … agent works, stops …
      → "keep working on the task" is sent automatically
      … until /loop off
```

The automatic rounds are injected as model-facing messages with a non-`user`
source kind, so the transcript does not grow a user bubble for every round.
`/loop status` and the `↻ loop N` footer field show the round count.

## Usage

| Command | Effect |
| --- | --- |
| `/loop <message>` | Arm the loop (or replace the message). If the agent is idle, round 1 is queued immediately; otherwise it starts when the current turn stops. |
| `/loop off` | Stop the loop. A round already queued but not yet claimed is removed from the inbox. The message is kept. |
| `/loop on` | Resume the last message (immediately when the agent is idle). |
| `/loop status` | Show whether the loop is on, its round count, and the last message. |
| `/loop` | Same as `/loop status`. |
| `/loop -- <message>` | Send a message that starts with a reserved word, e.g. `/loop -- off` loops the literal word `off`. |

Reserved whole-input words: `off`, `stop`, `clear`, `disable`; `on`, `start`,
`resume`, `enable`; `status`, `state`.

## How it works

1. The command arms a per-session loop and records the exact `Agent` that
   received it.
2. `agent/status` with `status: 'idle'` is the stop signal — `idle` means no
   driver remains scheduled or active. The plugin queues the stored message
   with `agent.followup(...)` after `delayMs`.
3. The follow-up opens a fresh turn. When that turn ends the agent goes idle
   again, and the loop queues the next round — forever, until stopped.
4. `session/event` `turn/end` records *why* the agent stopped, so the loop can
   pause on an interrupt or a failure instead of fighting the person or
   `dsh-turn-retry`.

The injected message looks like:

```js
{
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: '<message>' }],
  source: { kind: 'loop' },   // anything but 'user' stays out of the transcript
}
```

## Stop conditions

- `/loop off` — always wins; also clears a queued-but-unclaimed round.
- An **interrupted** turn (esc) pauses the loop (`stopOnAbort`, default
  `true`). Otherwise an interrupt could never take effect: the loop would
  resend immediately. `/loop on` resumes.
- A **failed** turn pauses the loop (`continueOnError`, default `false`) so it
  does not race `dsh-turn-retry`, which already retries failed turns. Set
  `continueOnError: true` to keep looping through errors.
- `max-tokens` and `blocked` turn endings pause the loop (they would just
  repeat the same failure).
- `maxRounds` (default `0` = unlimited) caps the round count.
- Disposing the agent (or unloading the plugin) forgets the loop.

## Install

From a clone of this repository:

```sh
dsh plugin --profile dsh-tui add link:"$(pwd)"
```

The package declares `dsh.bundle.patch`, so the CLI adds it to
`dsh.profile.bundles`; the bundle patch inserts the `loop` row. Restart the TUI
(`dst` / `dsh-tui`) and type `/loop <message>`.

No grant file entry is needed: `commands.invoke` defaults to allow, and the
manifest declares it for the `loop.loop` command id.

## Configure

Override the row by id in the profile's `cordis.patch.yml` user layer — never
insert a second same-id row:

```yaml
- id: loop
  config:
    delayMs: 250            # wait before each automatic send
    maxRounds: 0            # 0 = unlimited
    sourceKind: 'loop'      # non-'user' keeps rounds out of the transcript
    stopOnAbort: true       # esc pauses instead of resending
    continueOnError: false  # failed turns pause (dsh-turn-retry owns retries)
    notices: true           # toasts on start / pause / stop
    notifyEach: false       # toast on every automatic send
    footer: true            # `↻ loop N` footer field while active
```

Set `sourceKind: 'user'` if you want every round to appear as a user bubble in
the transcript (note that other plugins then treat it as a human prompt).

## Caveats

- **Per session, in memory.** Switching sessions leaves the loop running on
  the old session; restarting the TUI forgets it. `/loop off` is the stop.
- **The loop is literal.** The same text is sent after every stop, including
  when the model already finished. That is the point of the command; use
  `maxRounds` or `/loop off` to bound it.
- **No prompt interception.** The plugin only observes `agent/status` and
  `session/event`; it never rewrites the composer.

## Test

```sh
node test.mjs
```

## License

MIT
