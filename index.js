/**
 * dsh-loop — `/loop <message>`: resend one message every time the agent stops.
 *
 * The command arms a per-session loop. When the agent that received the
 * command reaches `idle` (a turn completed, failed, was interrupted, …), the
 * plugin queues the message again as a follow-up turn. That turn ends, the
 * agent goes idle again, and the loop repeats until `/loop off`.
 *
 * The injected message carries a non-`user` source kind, so dsh-TUI's
 * transcript projection — which renders direct human prompts only — does not
 * add a user bubble for every round. `/loop status` and the optional footer
 * field report the round count.
 *
 * Stop conditions (all configurable):
 * - `/loop off` (or clicking the footer field) stops immediately; a message
 *   queued but not yet claimed is removed from the inbox.
 * - `/loop on` resumes the last message.
 * - An interrupted (esc) turn pauses the loop (`stopOnAbort`, default true)
 *   instead of fighting the person who interrupted it.
 * - A failed turn pauses the loop (`continueOnError`, default false) so it
 *   does not race dsh-turn-retry's own retry of the same failed turn.
 * - `maxRounds` (default 0 = unlimited) caps the number of rounds.
 *
 * @module dsh-loop
 */

import { randomUUID } from 'node:crypto'

export const name = 'loop'

/** The agent registry is where rounds are injected; the command registry is `/loop`. */
export const inject = ['agents', 'commands']

/** The slash-command name (without the leading slash). */
export const COMMAND_NAME = 'loop'

/** Footer-field key (`ctx.tuiStatus.setField`). */
export const FOOTER_KEY = 'loop'

/** Source kind of the injected message; anything but `user` stays out of the transcript. */
export const DEFAULT_SOURCE_KIND = 'loop'

/** Delay before each automatic send, in milliseconds. */
export const DEFAULT_DELAY_MS = 250

/** Round cap; 0 means unlimited (the documented behaviour of `/loop`). */
export const DEFAULT_MAX_ROUNDS = 0

/** Pause the loop when a turn is interrupted (esc) rather than resending. */
export const DEFAULT_STOP_ON_ABORT = true

/** Pause the loop when a turn ends with an error (dsh-turn-retry owns retries). */
export const DEFAULT_CONTINUE_ON_ERROR = false

/** Show toasts for start / pause / stop. */
export const DEFAULT_NOTICES = true

/** Show a toast for every automatic send. */
export const DEFAULT_NOTIFY_EACH = false

/** Show a compact footer field while the loop is active. */
export const DEFAULT_FOOTER = true

/** `/loop` help, printed when the command has nothing to do. */
const USAGE = [
  'Usage: /loop <message> — resend <message> every time the agent stops',
  '       /loop off — stop the loop (the message is kept for /loop on)',
  '       /loop on — resume the last message',
  '       /loop status — show the current loop',
  '       /loop -- <message> — send a message that starts with a reserved word',
].join('\n')

/** Whole-input words that stop the loop. */
const STOP_WORDS = new Set(['off', 'stop', 'clear', 'disable'])

/** Whole-input words that resume the last message. */
const ON_WORDS = new Set(['on', 'start', 'resume', 'enable'])

/** Whole-input words that print the current state. */
const STATUS_WORDS = new Set(['status', 'state'])

/**
 * Coerce a config value to a non-empty string.
 * @param {unknown} value - raw config value.
 * @param {string} fallback - value used when the input is unusable.
 * @returns {string} the coerced string.
 */
const asText = (value, fallback) =>
  typeof value === 'string' && value.trim() !== '' ? value : fallback

/**
 * Coerce a config value to a boolean.
 * @param {unknown} value - raw config value.
 * @param {boolean} fallback - value used when the input is unusable.
 * @returns {boolean} the coerced boolean.
 */
const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/**
 * Coerce a config value to a finite number at or above `minimum`.
 * @param {unknown} value - raw config value.
 * @param {number} fallback - value used when the input is unusable.
 * @param {number} minimum - smallest accepted value.
 * @returns {number} the coerced number.
 */
const asNumber = (value, fallback, minimum) => {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  return Number.isFinite(number) && number >= minimum ? number : fallback
}

/**
 * Flatten a message for one-line display.
 * @param {string} text - the loop message.
 * @param {number} [limit] - maximum characters before the ellipsis.
 * @returns {string} the preview.
 */
const preview = (text, limit = 80) => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Render an unexpected thrown value for a log line.
 * @param {unknown} value - the thrown value.
 * @returns {string} human-readable text.
 */
const renderThrown = (value) => (value instanceof Error ? value.message : String(value))

/**
 * Wire the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {{
 *   delayMs?: number,
 *   maxRounds?: number,
 *   sourceKind?: string,
 *   stopOnAbort?: boolean,
 *   continueOnError?: boolean,
 *   notices?: boolean,
 *   notifyEach?: boolean,
 *   footer?: boolean,
 * }} [config] - Row config.
 */
export function apply(ctx, config = {}) {
  const row = config !== null && typeof config === 'object' ? config : {}
  const delayMs = asNumber(row.delayMs, DEFAULT_DELAY_MS, 0)
  const maxRounds = Math.floor(asNumber(row.maxRounds, DEFAULT_MAX_ROUNDS, 0))
  const sourceKind = asText(row.sourceKind, DEFAULT_SOURCE_KIND)
  const stopOnAbort = asBoolean(row.stopOnAbort, DEFAULT_STOP_ON_ABORT)
  const continueOnError = asBoolean(row.continueOnError, DEFAULT_CONTINUE_ON_ERROR)
  const notices = asBoolean(row.notices, DEFAULT_NOTICES)
  const notifyEach = asBoolean(row.notifyEach, DEFAULT_NOTIFY_EACH)
  const footer = asBoolean(row.footer, DEFAULT_FOOTER)

  /**
   * Per-agent loop state. Keyed by the exact Agent object the command was
   * invoked on, so a replaced/resumed session can never inherit a loop.
   * @type {Map<object, {
   *   agent: any,
   *   text: string,
   *   enabled: boolean,
   *   pausedReason: string | undefined,
   *   round: number,
   *   pending: boolean,
   *   pendingMessageId: string | undefined,
   *   timer: ReturnType<typeof setTimeout> | undefined,
   *   generation: number,
   *   lastEnd: string | undefined,
   * }>}
   */
  const states = new Map()

  /** The disposer of the current footer write (token-checked by the host). */
  let footerDispose
  /** The state currently owning the footer field. */
  let footerOwner

  /**
   * Soft-probe an optional service without failing the plugin.
   * @param {string} service - service name.
   * @returns {any} the service, or undefined when absent.
   */
  const soft = (service) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(service, false) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Show a transient toast when the host exposes the seam.
   * @param {string} text - toast text.
   * @param {'success' | 'warning' | 'error'} [color] - toast color.
   */
  const toast = (text, color) => {
    if (!notices) return
    try {
      const service = soft('tuiToast')
      service?.show?.(text, {
        ...(color === undefined ? {} : { color }),
        timeoutMs: 4000,
      })
    } catch {
      // A toast must never take the plugin down.
    }
  }

  /**
   * The state record for one agent.
   * @param {any} agent - the receiving agent.
   * @returns {any} its state.
   */
  const stateFor = (agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        agent,
        text: '',
        enabled: false,
        pausedReason: undefined,
        round: 0,
        pending: false,
        pendingMessageId: undefined,
        timer: undefined,
        generation: 0,
        lastEnd: undefined,
      }
      states.set(agent, state)
    }
    return state
  }

  /**
   * Drop a pending injection timer.
   * @param {any} state - the loop state.
   */
  const clearTimer = (state) => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /**
   * Remove the message this loop queued but the driver has not claimed yet.
   * @param {any} state - the loop state.
   */
  const removePending = (state) => {
    const id = state.pendingMessageId
    state.pending = false
    state.pendingMessageId = undefined
    if (id === undefined) return
    try {
      state.agent.inbox?.remove?.(id)
    } catch {
      // The inbox already claimed or discarded it.
    }
  }

  /**
   * Publish or clear the footer field for one state.
   * @param {any} state - the loop state.
   */
  const renderFooter = (state) => {
    if (!footer) return
    const service = soft('tuiStatus')
    if (service === undefined || typeof service.setField !== 'function') return
    try {
      if (state.enabled) {
        footerDispose = service.setField(FOOTER_KEY, `↻ loop ${state.round}`, {
          slot: 'right-head',
          tone: 'accent',
          maxCells: 16,
          detail: `Loop active — round ${state.round}. Sends "${preview(state.text, 60)}" whenever the agent stops. Click to stop.`,
          onClick: () => stop(state),
        })
        footerOwner = state
      } else if (footerOwner === state) {
        footerDispose?.()
        footerDispose = undefined
        footerOwner = undefined
      }
    } catch {
      // A footer must never take the plugin down.
    }
  }

  /**
   * Build the model-facing message for one round.
   * @param {any} state - the loop state.
   * @returns {{ id: string, role: 'user', content: { type: 'text', text: string }[], source: { kind: string } }} the message.
   */
  const buildMessage = (state) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: state.text }],
    source: { kind: sourceKind },
  })

  /**
   * Queue one round if the loop is still armed and the agent is quiescent.
   * @param {any} state - the loop state.
   */
  const injectRound = (state) => {
    state.timer = undefined
    if (!state.enabled) return
    const { agent } = state
    if (ctx.agents.get(agent.id) !== agent) {
      // The session was replaced or disposed: stop quietly.
      state.enabled = false
      state.pausedReason = undefined
      state.generation += 1
      removePending(state)
      renderFooter(state)
      return
    }
    if (agent.status !== 'idle') {
      // A turn started between the idle event and this timer. The next idle
      // event schedules the next round; injecting now would race that turn.
      return
    }
    if (maxRounds > 0 && state.round >= maxRounds) {
      pause(state, `round limit reached (${maxRounds})`)
      return
    }

    const message = buildMessage(state)
    const round = state.round + 1
    state.pending = true
    state.pendingMessageId = message.id
    state.round = round
    try {
      agent.followup(message)
    } catch (error) {
      state.pending = false
      state.pendingMessageId = undefined
      state.round = round - 1
      ctx.logger?.warn?.(`loop: could not queue round ${round}: ${renderThrown(error)}`)
      pause(state, 'could not queue the message')
      return
    }
    renderFooter(state)
    if (notifyEach) toast(`↻ loop ${round}`)
  }

  /**
   * Arm the next round after `delayMs`.
   * @param {any} state - the loop state.
   * @param {number} [delay] - override for the configured delay.
   */
  const scheduleInject = (state, delay = delayMs) => {
    if (!state.enabled) return
    if (state.timer !== undefined) return
    const generation = state.generation
    const timer = setTimeout(() => {
      if (state.timer === timer) state.timer = undefined
      if (state.generation !== generation) return
      injectRound(state)
    }, Math.max(0, delay))
    // Never keep a shutting-down process alive for a loop round.
    timer.unref?.()
    state.timer = timer
  }

  /**
   * Pause an armed loop, keeping its message for `/loop on`.
   * @param {any} state - the loop state.
   * @param {string} reason - why it paused.
   */
  const pause = (state, reason) => {
    if (!state.enabled) return
    state.enabled = false
    state.pausedReason = reason
    clearTimer(state)
    state.generation += 1
    renderFooter(state)
    toast(`↻ loop paused — ${reason}. /loop on resumes.`, 'warning')
  }

  /**
   * Stop the loop and drop a message that has not been claimed yet.
   * @param {any} state - the loop state.
   * @param {{ notify?: boolean }} [options] - notification override.
   */
  const stop = (state, options = {}) => {
    const wasEnabled = state.enabled
    state.enabled = false
    state.pausedReason = undefined
    clearTimer(state)
    state.generation += 1
    removePending(state)
    renderFooter(state)
    if (wasEnabled && options.notify !== false) toast('↻ loop off')
  }

  /**
   * Resume the last message, starting immediately when the agent is idle.
   * @param {any} state - the loop state.
   */
  const resume = (state) => {
    state.enabled = true
    state.pausedReason = undefined
    state.generation += 1
    renderFooter(state)
    if (state.agent.status === 'idle') scheduleInject(state)
  }

  /**
   * Arm a loop with a fresh message.
   * @param {any} state - the loop state.
   * @param {string} text - the message to resend.
   * @returns {boolean} whether the first round was queued immediately.
   */
  const start = (state, text) => {
    clearTimer(state)
    removePending(state)
    state.text = text
    state.round = 0
    state.generation += 1
    state.enabled = true
    state.pausedReason = undefined
    renderFooter(state)
    const idle = state.agent.status === 'idle'
    if (idle) scheduleInject(state)
    return idle
  }

  /**
   * The `/loop status` report.
   * @param {any} state - the loop state.
   * @returns {string} the report text.
   */
  const statusText = (state) => {
    if (state.enabled) {
      return [
        `↻ loop is ON — round ${state.round}${state.pending ? ' (next round queued)' : ''}`,
        `   message: ${preview(state.text, 120)}`,
        '   /loop off stops · /loop <message> replaces',
      ].join('\n')
    }
    if (state.text !== '') {
      const paused = state.pausedReason === undefined ? '' : ` (paused: ${state.pausedReason})`
      return [
        `↻ loop is OFF${paused}`,
        `   last message: ${preview(state.text, 120)}`,
        '   /loop on resumes · /loop <message> replaces',
      ].join('\n')
    }
    return ['↻ loop is OFF — no message set', USAGE].join('\n')
  }

  /**
   * The command handler.
   * @param {import('@deepseek-ai/dsh-commands').CommandInvocation | undefined} invocation - the invocation.
   * @returns {{ kind: 'success', text?: string } | { kind: 'error', text: string }} the result.
   */
  const handler = (invocation) => {
    const agent = invocation?.agent
    if (agent === undefined || agent === null) {
      return { kind: 'error', text: 'loop: this invocation has no agent' }
    }
    const state = stateFor(agent)
    const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput : ''
    const input = raw.trim()

    // `/loop -- off` sends the literal word "off" instead of stopping. Only a
    // bare `--` or `-- ` is the escape, so `/loop --verbose` stays literal.
    if (/^--(?:\s|$)/u.test(input)) {
      const literal = input.replace(/^--\s*/u, '').trim()
      if (literal === '') return { kind: 'error', text: USAGE }
      start(state, literal)
      return {
        kind: 'success',
        text: `↻ loop on — sends "${preview(literal)}" every time the agent stops.\n   /loop off stops · /loop status shows the round count.`,
      }
    }

    const word = input.toLowerCase()
    if (input === '' || STATUS_WORDS.has(word)) {
      return { kind: 'success', text: statusText(state) }
    }
    if (STOP_WORDS.has(word)) {
      if (!state.enabled) return { kind: 'success', text: statusText(state) }
      stop(state)
      return {
        kind: 'success',
        text: '↻ loop off — the message is kept; /loop on resumes.',
      }
    }
    if (ON_WORDS.has(word)) {
      if (state.text === '') {
        return { kind: 'error', text: `loop: nothing to resume.\n${USAGE}` }
      }
      if (state.enabled) return { kind: 'success', text: statusText(state) }
      resume(state)
      return {
        kind: 'success',
        text: `↻ loop on — sends "${preview(state.text)}" every time the agent stops.`,
      }
    }

    const idle = start(state, input)
    return {
      kind: 'success',
      text: [
        `↻ loop on — ${idle ? 'first round queued' : 'starts when the current turn stops'}.`,
        `   sends "${preview(input)}" every time the agent stops.`,
        '   /loop off stops · /loop status shows the round count.',
      ].join('\n'),
    }
  }

  // ── stop detection ────────────────────────────────────────────────────────
  // A turn closer records WHY the agent stopped; the idle transition is the
  // moment a new round may be queued. `agent/status` is the exact quiescence
  // signal: `idle` means no driver remains scheduled or active.
  ctx.on('session/event', (session, event) => {
    if (session === undefined || event === undefined) return
    if (event.type !== 'turn/end') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const state = states.get(agent)
    if (state === undefined) return
    state.lastEnd = event.data?.reason?.kind
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const state = states.get(agent)
    if (state === undefined || !state.enabled) return
    const reason = state.lastEnd
    state.lastEnd = undefined

    if (reason === 'aborted') {
      if (stopOnAbort) {
        pause(state, 'the turn was interrupted')
        return
      }
    } else if (reason === 'error') {
      if (!continueOnError) {
        pause(state, 'the turn ended with an error')
        return
      }
    } else if (reason === 'max-tokens') {
      pause(state, 'the output token limit was reached')
      return
    } else if (reason === 'blocked') {
      pause(state, 'the turn was blocked before it started')
      return
    } else if (reason === 'interrupted' || reason === 'forked') {
      // Crash/fork repair markers are never emitted by a live loop.
      return
    }

    scheduleInject(state)
  })

  // A claimed round is running; a discarded one never happened (the person
  // cancelled the queue), so forget it and let the next idle retry.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const state = states.get(agent)
    if (state === undefined || message?.id !== state.pendingMessageId) return
    state.pending = false
    state.pendingMessageId = undefined
    renderFooter(state)
  })

  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const state = states.get(agent)
    if (state === undefined || message?.id !== state.pendingMessageId) return
    state.pending = false
    state.pendingMessageId = undefined
    state.round = Math.max(0, state.round - 1)
    if (state.enabled && agent.status === 'idle') scheduleInject(state)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state === undefined) return
    clearTimer(state)
    states.delete(agent)
    if (footerOwner === state) {
      footerDispose?.()
      footerDispose = undefined
      footerOwner = undefined
    }
  })

  // ── command registration ──────────────────────────────────────────────────
  const definition = {
    name: COMMAND_NAME,
    description: 'Resend a message every time the agent stops (infinite loop; /loop off stops)',
    input: { hint: '<message> | off | on | status' },
    handler,
  }

  /**
   * Register through the mediated surface when the TUI offers it (it stamps
   * the command's owner for the invoke checkpoint), else the plain registry.
   * @returns {(() => void) | undefined} the disposer.
   */
  const registerCommand = () => {
    const host = soft('tuiPluginHost')
    if (host !== undefined && typeof host.registerCommand === 'function') {
      try {
        return host.registerCommand(ctx, definition)
      } catch (error) {
        ctx.logger?.warn?.(
          `loop: mediated command registration failed, falling back (${renderThrown(error)})`,
        )
      }
    }
    const commands = ctx.commands ?? soft('commands')
    if (commands !== undefined && typeof commands.register === 'function') {
      return commands.register(definition)
    }
    ctx.logger?.warn?.('loop: no command service mounted; /loop is unavailable')
    return undefined
  }

  const disposeCommand = registerCommand()

  ctx.effect(() => () => {
    if (typeof disposeCommand === 'function') disposeCommand()
    for (const state of states.values()) clearTimer(state)
    states.clear()
    footerDispose?.()
    footerDispose = undefined
    footerOwner = undefined
  })
}
