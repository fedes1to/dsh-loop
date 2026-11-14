import assert from 'node:assert/strict'
import {
  apply,
  COMMAND_NAME,
  DEFAULT_SOURCE_KIND,
  FOOTER_KEY,
} from './index.js'

/** Wait for the plugin's deferred (setTimeout) work to run. */
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mount the plugin on a fake Cordis context: a fake agent registry with one
 * idle agent, a fake command registry, and recording toast/status services.
 *
 * @param {object} [config] - row config.
 * @param {{ status?: 'idle' | 'running' }} [options] - initial agent status.
 */
function mount(config = {}, { status = 'idle' } = {}) {
  const handlers = new Map()
  const agents = new Map()
  const calls = []
  const toasts = []
  const fields = []
  const services = {}
  let definition
  let unload

  const agent = {
    id: 'session-1',
    session: { id: 'session-1' },
    status,
    inbox: {
      queued: new Map(),
      remove(id) {
        return this.queued.delete(id)
      },
    },
    followup(message) {
      calls.push(message)
      this.inbox.queued.set(message.id, message)
      this.status = 'running'
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
  agents.set(agent.id, agent)

  services.tuiToast = {
    show(text, options) {
      toasts.push({ text, options })
      return true
    },
  }
  services.tuiStatus = {
    setField(key, text, options) {
      fields.push({ key, text, options })
      return () => {
        fields.push({ key, text: undefined, cleared: true })
      }
    },
  }

  const ctx = {
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    },
    commands: {
      register(registered) {
        definition = registered
        return () => {
          definition = undefined
        }
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(fn) {
      unload = fn()
      return unload
    },
    get(service) {
      return services[service]
    },
    logger: { warn() {}, info() {} },
  }

  apply(ctx, config)

  const emit = (event, ...args) => {
    for (const handler of handlers.get(event) ?? []) handler(...args)
  }

  const run = (rawInput, invocationAgent = agent) =>
    definition.handler({
      agent: invocationAgent,
      rawInput,
      signal: new AbortController().signal,
    })

  /** Simulate a turn closer followed by the idle transition. */
  const stop = async (reason = 'completed') => {
    emit('session/event', agent.session, {
      type: 'turn/end',
      data: { reason: { kind: reason } },
    })
    agent.status = 'idle'
    emit('agent/status', { agent, status: 'idle' })
    await tick()
  }

  /** Simulate the driver claiming the last queued message. */
  const claim = () => {
    const message = calls.at(-1)
    if (message === undefined) return
    agent.inbox.queued.delete(message.id)
    emit('agent/inbox/claimed', { agent, message })
  }

  return {
    ctx,
    agent,
    agents,
    calls,
    toasts,
    fields,
    emit,
    run,
    stop,
    claim,
    unload: () => unload?.(),
    get definition() {
      return definition
    },
  }
}

// The command is registered with the expected surface.
{
  const h = mount()
  assert.equal(h.definition?.name, COMMAND_NAME)
  assert.equal(typeof h.definition?.description, 'string')
  assert.equal(typeof h.definition?.handler, 'function')
  assert.equal(h.definition?.input?.hint, '<message> | off | on | status')
}

// `/loop <message>` while idle queues the first round immediately.
{
  const h = mount({ delayMs: 0 })
  const result = h.run(' keep going')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /first round queued/)
  assert.equal(h.calls.length, 0, 'the first round is deferred, not re-entrant')
  await tick()
  assert.equal(h.calls.length, 1)
  const message = h.calls[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, 'keep going')
  assert.equal(message.source.kind, DEFAULT_SOURCE_KIND)
  assert.notEqual(message.source.kind, 'user')
  assert.equal(typeof message.id, 'string')
}

// Every time the agent stops, the same message is sent again.
{
  const h = mount({ delayMs: 0 })
  h.run(' again')
  await tick()
  assert.equal(h.calls.length, 1)
  h.claim()
  await h.stop('completed')
  assert.equal(h.calls.length, 2)
  h.claim()
  await h.stop('completed')
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].content[0].text, 'again')
}

// Enabling while a turn is running waits for that turn to stop.
{
  const h = mount({ delayMs: 0 }, { status: 'running' })
  h.run(' later')
  await tick()
  assert.equal(h.calls.length, 0)
  await h.stop('completed')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].content[0].text, 'later')
}

// `/loop off` stops the loop and removes a message that is still queued.
{
  const h = mount({ delayMs: 0 })
  h.run(' stop me')
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.agent.inbox.queued.size, 1)
  const result = h.run(' off')
  assert.equal(result.kind, 'success')
  assert.equal(h.agent.inbox.queued.size, 0)
  await h.stop('completed')
  assert.equal(h.calls.length, 1)
}

// `/loop status` reports the state; `/loop on` resumes the last message.
{
  const h = mount({ delayMs: 0 })
  h.run(' resume me')
  await tick()
  h.claim()
  h.run(' off')
  h.agent.status = 'idle'
  const off = h.run(' status')
  assert.match(off.text, /OFF/)
  assert.match(off.text, /resume me/)
  const on = h.run(' on')
  assert.equal(on.kind, 'success')
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].content[0].text, 'resume me')
}

// An interrupted turn pauses instead of fighting the person.
{
  const h = mount({ delayMs: 0 })
  h.run(' keep going')
  await tick()
  h.claim()
  await h.stop('aborted')
  assert.equal(h.calls.length, 1)
  assert.ok(h.toasts.some((toast) => /paused/.test(toast.text)))
  assert.match(h.run(' status').text, /paused/)
  await h.stop('completed')
  assert.equal(h.calls.length, 1)
}

// `stopOnAbort: false` keeps looping through an interrupt.
{
  const h = mount({ delayMs: 0, stopOnAbort: false })
  h.run(' keep going')
  await tick()
  h.claim()
  await h.stop('aborted')
  assert.equal(h.calls.length, 2)
}

// A failed turn pauses by default (dsh-turn-retry owns retries)…
{
  const h = mount({ delayMs: 0 })
  h.run(' keep going')
  await tick()
  h.claim()
  await h.stop('error')
  assert.equal(h.calls.length, 1)
  assert.match(h.run(' status').text, /error/)
}

// …unless `continueOnError` is enabled.
{
  const h = mount({ delayMs: 0, continueOnError: true })
  h.run(' keep going')
  await tick()
  h.claim()
  await h.stop('error')
  assert.equal(h.calls.length, 2)
}

// `maxRounds` caps the loop.
{
  const h = mount({ delayMs: 0, maxRounds: 2 })
  h.run(' capped')
  await tick()
  assert.equal(h.calls.length, 1)
  h.claim()
  await h.stop('completed')
  assert.equal(h.calls.length, 2)
  h.claim()
  await h.stop('completed')
  assert.equal(h.calls.length, 2)
  assert.match(h.run(' status').text, /round limit/)
}

// `--` escapes a message that starts with a reserved word.
{
  const h = mount({ delayMs: 0 })
  const result = h.run(' -- off')
  assert.equal(result.kind, 'success')
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].content[0].text, 'off')
}

// A normal `--flag` message is not an escape.
{
  const h = mount({ delayMs: 0 })
  h.run(' --verbose')
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].content[0].text, '--verbose')
}

// `/loop on` with nothing to resume is an error, not a silent no-op.
{
  const h = mount()
  assert.equal(h.run(' on').kind, 'error')
  assert.equal(h.run('').kind, 'success')
}

// Malformed invocations are answered, never thrown.
{
  const h = mount()
  assert.equal(h.definition.handler(undefined).kind, 'error')
  assert.equal(h.definition.handler({ agent: h.agent }).kind, 'success')
  assert.equal(h.definition.handler({ agent: h.agent, rawInput: 42 }).kind, 'success')
}

// The footer field follows the round count and clears on stop.
{
  const h = mount({ delayMs: 0 })
  h.run(' footer test')
  assert.ok(h.fields.some((field) => field.key === FOOTER_KEY && field.text === '↻ loop 0'))
  await tick()
  assert.ok(h.fields.some((field) => field.text === '↻ loop 1'))
  h.run(' off')
  assert.ok(h.fields.some((field) => field.cleared === true))
}

// Config coercion: custom source kind, notices/footer off.
{
  const h = mount({
    delayMs: '5',
    sourceKind: 'my-loop',
    notices: false,
    footer: false,
  })
  h.run(' custom')
  await tick(20)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].source.kind, 'my-loop')
  assert.equal(h.toasts.length, 0)
  assert.equal(h.fields.length, 0)
}

// A disposed agent is forgotten: no round is queued for it.
{
  const h = mount({ delayMs: 0 })
  h.run(' keep going')
  await tick()
  h.emit('agent/disposed', { agent: h.agent })
  h.agents.delete(h.agent.id)
  await h.stop('completed')
  assert.equal(h.calls.length, 1)
}

// Two idle notifications for one stop queue only one round.
{
  const h = mount({ delayMs: 0 })
  h.run(' once')
  await tick()
  assert.equal(h.calls.length, 1)
  h.claim()
  h.agent.status = 'idle'
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  await tick()
  assert.equal(h.calls.length, 2)
}

// A discarded (cancelled) round is retried instead of stalling the loop.
{
  const h = mount({ delayMs: 0 })
  h.run(' again')
  await tick()
  assert.equal(h.calls.length, 1)
  const message = h.calls[0]
  h.agent.inbox.queued.delete(message.id)
  h.agent.status = 'idle'
  h.emit('agent/inbox/discarded', { agent: h.agent, message })
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].content[0].text, 'again')
}

// Unloading disposes the command and cancels a pending round.
{
  const h = mount({ delayMs: 50 })
  h.run(' pending')
  h.unload()
  assert.equal(h.definition, undefined)
  await tick(80)
  assert.equal(h.calls.length, 0)
}

console.log('ok — /loop resends the message every time the agent stops')
