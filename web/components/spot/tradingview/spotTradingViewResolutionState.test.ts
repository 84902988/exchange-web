/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness keeps Node's TS runner compatible with production extensionless imports. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

type SpotChartLoadingClock = {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

type SpotChartLoadingToken = Readonly<{
  widgetGeneration: number
  sequence: number
  intent: string
  startedAt: number
}>

type SpotSetResolutionOptions = { dataReady?: () => void } | (() => void) | undefined

function loadTypeScriptModule(
  filePath: string,
  mocks: Record<string, unknown>,
): Record<string, any> {
  const source = readFileSync(filePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText
  const loadedModule: { exports: Record<string, any> } = { exports: {} }
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    throw new Error(`Unexpected test import: ${specifier}`)
  }
  const execute = new Function('require', 'module', 'exports', output)
  execute(localRequire, loadedModule, loadedModule.exports)
  return loadedModule.exports
}

const protocolModule = loadTypeScriptModule(
  fileURLToPath(new URL('../../tradingview/klineLifecycleProtocol.ts', import.meta.url)),
  {},
)
const resolutionStateModule = loadTypeScriptModule(
  fileURLToPath(new URL('./spotTradingViewResolutionState.ts', import.meta.url)),
  {},
)
const runtimeCoordinatorModule = loadTypeScriptModule(
  fileURLToPath(new URL('../../tradingview/klineLifecycleRuntimeCoordinator.ts', import.meta.url)),
  {
    './klineLifecycleProtocol': protocolModule,
    './klineLifecycleObservability': {
      recordKlineLifecycleDecision: () => undefined,
      recordKlineLifecycleResetExecution: () => undefined,
    },
  },
)
const {
  requestSpotSetResolution,
  scheduleSpotSubscriberReadinessGrace,
  setSpotToolbarLoadingState,
  SPOT_SUBSCRIBER_READINESS_GRACE_MS,
  shouldRequestSpotChartSubscriberRearm,
  shouldStartSpotChartResolutionChange,
  SpotChartLoadingCoordinator,
  SpotResolutionIntentCoordinator,
} = resolutionStateModule
const {
  KlineLifecycleRuntimeCoordinator,
} = runtimeCoordinatorModule

function lifecycleRuntime(overrides: Record<string, unknown> = {}) {
  return new KlineLifecycleRuntimeCoordinator({
    terminalType: 'SPOT',
    widgetGeneration: 1,
    datafeedInstanceId: 7,
    symbol: 'BTCUSDT',
    ...overrides,
  })
}

function subscriberEvidence(identity: Record<string, any>, generation = 1) {
  return {
    ...identity,
    subscriberUid: 'spot-series',
    subscriptionGeneration: generation,
    ownerId: 'tradingview:BTCUSDT:7:spot-series',
  }
}

class FakeClock implements SpotChartLoadingClock {
  nowValue = 0
  nextId = 1
  tasks = new Map<number, { at: number; callback: () => void }>()

  now = () => this.nowValue

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId
    this.nextId += 1
    this.tasks.set(id, { at: this.nowValue + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout = (handle: unknown) => {
    this.tasks.delete(Number(handle))
  }

  advanceBy(milliseconds: number) {
    const target = this.nowValue + milliseconds
    while (true) {
      const next = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.nowValue = task.at
      task.callback()
    }
    this.nowValue = target
  }
}

function fakeElement() {
  const attributes = new Map<string, string>()
  return {
    attributes,
    disabled: false,
    style: { pointerEvents: '' },
    tabIndex: 0,
    setAttribute(name: string, value: string) {
      attributes.set(name, value)
    },
    removeAttribute(name: string) {
      attributes.delete(name)
    },
  }
}

test('1m -> 1D -> 1W -> 1M -> 1m loading sequences all settle once', () => {
  const clock = new FakeClock()
  const changes: string[] = []
  const settled: number[] = []
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: (reason: string) => changes.push(reason),
    onSettled: (token: SpotChartLoadingToken) => settled.push(token.sequence),
  })

  for (const interval of ['1m', '1D', '1W', '1M', '1m']) {
    const token = coordinator.start(1, interval)
    assert.equal(coordinator.finish(token), true)
    assert.equal(coordinator.finish(token), false)
    clock.advanceBy(220)
  }

  assert.deepEqual(changes, ['1m', '', '1D', '', '1W', '', '1M', '', '1m', ''])
  assert.deepEqual(settled, [1, 2, 3, 4, 5])
})

test('empty interval completion unlocks the next interval switch', () => {
  const clock = new FakeClock()
  const changes: string[] = []
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: (reason: string) => changes.push(reason),
  })

  const emptyToken = coordinator.start(1, 'RCBUSDT:4H:empty')
  assert.equal(coordinator.finish(emptyToken), true)
  clock.advanceBy(220)
  const nextToken = coordinator.start(1, 'BTCUSDT:1D')
  assert.equal(nextToken.sequence, emptyToken.sequence + 1)
  assert.equal(coordinator.finish(nextToken), true)
  clock.advanceBy(220)

  assert.deepEqual(changes, ['RCBUSDT:4H:empty', '', 'BTCUSDT:1D', ''])
})

test('retired widget generation cannot finish or unlock the next widget loading', () => {
  const clock = new FakeClock()
  const changes: string[] = []
  const settled: Array<{ generation: number; sequence: number }> = []
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: (reason: string) => changes.push(reason),
    onSettled: (token: SpotChartLoadingToken) => settled.push({
      generation: token.widgetGeneration,
      sequence: token.sequence,
    }),
  })

  const widgetA = coordinator.start(1, 'widget-build')
  assert.equal(coordinator.retireGeneration(1), true)
  const widgetB = coordinator.start(2, 'widget-build')

  assert.equal(coordinator.finish(widgetA), false)
  assert.equal(coordinator.isActive(widgetB), true)
  clock.advanceBy(5_000)

  assert.equal(coordinator.isActive(widgetB), false)
  assert.deepEqual(settled, [{ generation: 2, sequence: widgetB.sequence }])
  assert.deepEqual(changes, ['widget-build', '', 'widget-build', ''])
})

test('precision-style widget rebuild leaves only the current generation safety timer', () => {
  const clock = new FakeClock()
  const changes: string[] = []
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: (reason: string) => changes.push(reason),
  })

  coordinator.start(1, 'widget-build')
  assert.equal(clock.tasks.size, 1)
  coordinator.retireGeneration(1)
  assert.equal(clock.tasks.size, 0)
  const current = coordinator.start(2, 'widget-build')
  assert.equal(clock.tasks.size, 1)

  clock.advanceBy(5_000)
  assert.equal(coordinator.isActive(current), false)
  assert.equal(clock.tasks.size, 0)
  assert.equal(changes.at(-1), '')
})

test('same resolution and unavailable chart do not require a resolution loading token', () => {
  assert.equal(shouldStartSpotChartResolutionChange({
    widgetAvailable: true,
    chartReady: true,
    observedResolution: '1M',
    nextResolution: '1M',
  }), false)
  assert.equal(shouldStartSpotChartResolutionChange({
    widgetAvailable: true,
    chartReady: false,
    observedResolution: '1D',
    nextResolution: '1M',
  }), false)
  assert.equal(shouldStartSpotChartResolutionChange({
    widgetAvailable: true,
    chartReady: true,
    observedResolution: '1D',
    nextResolution: '1M',
  }), true)
})

test('loading token records widget generation sequence intent and start time', () => {
  const clock = new FakeClock()
  clock.nowValue = 1234
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: () => undefined,
  })

  const token = coordinator.start(7, 'resolution-change')

  assert.deepEqual(token, {
    widgetGeneration: 7,
    sequence: 1,
    intent: 'resolution-change',
    startedAt: 1234,
  })
})

test('destroy cancels the current widget loading timer without settling it', () => {
  const clock = new FakeClock()
  const settled: number[] = []
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: () => undefined,
    onSettled: (token: SpotChartLoadingToken) => settled.push(token.sequence),
  })
  const token = coordinator.start(1, 'widget-build')
  assert.equal(coordinator.isActive(token), true)
  assert.equal(clock.tasks.size, 1)

  coordinator.destroy()
  clock.advanceBy(10_000)

  assert.equal(coordinator.isActive(token), false)
  assert.equal(clock.tasks.size, 0)
  assert.deepEqual(settled, [])
})

test('toolbar remains interactive while exposing busy and pending state', () => {
  const slot = fakeElement()
  slot.disabled = true
  slot.setAttribute('aria-disabled', 'true')
  const button = fakeElement()
  const buttons = new Map([['1M', button]])

  setSpotToolbarLoadingState(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    { loading: true, pendingKey: '1M' },
  )
  assert.equal(slot.attributes.get('aria-busy'), 'true')
  assert.equal(slot.attributes.has('aria-disabled'), false)
  assert.equal(slot.disabled, false)
  assert.equal(slot.tabIndex, 0)
  assert.equal(slot.style.pointerEvents, 'auto')
  assert.equal(button.attributes.get('data-resolution-pending'), 'true')
  assert.equal(button.attributes.has('aria-disabled'), false)
  assert.equal(button.disabled, false)
  assert.equal(button.tabIndex, 0)

  setSpotToolbarLoadingState(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    { loading: false },
  )
  assert.equal(slot.attributes.has('aria-busy'), false)
  assert.equal(slot.attributes.has('aria-disabled'), false)
  assert.equal(button.attributes.has('data-resolution-pending'), false)
  assert.equal(button.attributes.has('aria-disabled'), false)
  assert.equal(button.disabled, false)
  assert.equal(button.tabIndex, 0)
})

test('toolbar restore clears late TradingView disabled state from slot and buttons', () => {
  const slot = fakeElement()
  const button = fakeElement()
  const buttons = new Map([['1m', button]])

  slot.disabled = true
  slot.setAttribute('aria-disabled', 'true')
  button.disabled = true
  button.setAttribute('aria-disabled', 'true')

  setSpotToolbarLoadingState(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    { loading: false },
  )

  assert.equal(slot.disabled, false)
  assert.equal(slot.attributes.has('aria-disabled'), false)
  assert.equal(button.disabled, false)
  assert.equal(button.attributes.has('aria-disabled'), false)
})

test('setResolution failure restores toolbar and keeps page highlight on actual resolution', () => {
  const clock = new FakeClock()
  const slot = fakeElement()
  const button = fakeElement()
  const buttons = new Map([['1D', button]])
  const actualResolution = '1'
  let highlightedInterval = '1m'
  const changes: string[] = []
  const coordinator = new SpotChartLoadingCoordinator({
    clock,
    onChange: (reason: string) => changes.push(reason),
    onSettled: () => setSpotToolbarLoadingState(
      slot as unknown as HTMLElement,
      buttons as unknown as Map<string, HTMLButtonElement>,
      { loading: false },
    ),
  })
  const loadingToken = coordinator.start(1, '1D')
  setSpotToolbarLoadingState(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    { loading: true },
  )

  requestSpotSetResolution({
    chart: {
      setResolution: () => false,
      resolution: () => actualResolution,
    },
    resolution: '1D',
    isCurrent: () => true,
    onCommitted: () => assert.fail('failed resolution must not commit'),
    onFailed: () => {
      highlightedInterval = '1m'
      coordinator.finish(loadingToken)
    },
    clock,
  })
  clock.advanceBy(220)

  assert.equal(actualResolution, '1')
  assert.equal(highlightedInterval, '1m')
  assert.equal(button.disabled, false)
  assert.equal(button.attributes.has('aria-disabled'), false)
  assert.deepEqual(changes, ['1D', ''])
})

test('page highlight commits only after setResolution confirms the actual resolution', () => {
  const clock = new FakeClock()
  let actualResolution = '1'
  let highlightedInterval = '1m'
  let dataReady: (() => void) | undefined

  requestSpotSetResolution({
    chart: {
      setResolution: (resolution: string, options: SpotSetResolutionOptions) => {
        actualResolution = resolution
        dataReady = typeof options === 'function' ? options : options?.dataReady
      },
      resolution: () => actualResolution,
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: () => {
      highlightedInterval = '1M'
    },
    onFailed: assert.fail,
    clock,
  })

  assert.equal(highlightedInterval, '1m')
  assert.equal(actualResolution, '1M')
  dataReady?.()
  assert.equal(highlightedInterval, '1M')
})

test('dataReady is authoritative even while chart resolution getter is stale', () => {
  const clock = new FakeClock()
  let dataReady: (() => void) | undefined
  let highlightedInterval = '1m'
  const failures: string[] = []

  requestSpotSetResolution({
    chart: {
      setResolution: (_resolution: string, options: SpotSetResolutionOptions) => {
        dataReady = typeof options === 'function' ? options : options?.dataReady
      },
      resolution: () => '1',
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: () => {
      highlightedInterval = '1M'
    },
    onFailed: (reason: string) => failures.push(reason),
    clock,
  })

  dataReady?.()
  assert.equal(highlightedInterval, '1M')
  assert.deepEqual(failures, [])
})

test('setResolution promise acceptance waits for dataReady before committing', async () => {
  const clock = new FakeClock()
  let dataReady: (() => void) | undefined
  let resolveSetResolution!: (changed: boolean) => void
  const setResolutionResult = new Promise<boolean>((resolve) => {
    resolveSetResolution = resolve
  })
  const commits: string[] = []

  requestSpotSetResolution({
    chart: {
      setResolution: (_resolution: string, options: SpotSetResolutionOptions) => {
        dataReady = typeof options === 'function' ? options : options?.dataReady
        return setResolutionResult
      },
      resolution: () => '1M',
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: (reason: string) => commits.push(reason),
    onFailed: assert.fail,
    clock,
  })

  resolveSetResolution(true)
  await Promise.resolve()
  assert.deepEqual(commits, [])
  dataReady?.()
  assert.deepEqual(commits, ['dataReady'])
})

test('dataReady before the setResolution promise commits once and late settlement cannot roll it back', async () => {
  const clock = new FakeClock()
  let dataReady: (() => void) | undefined
  let resolveSetResolution!: (changed: boolean) => void
  const setResolutionResult = new Promise<boolean>((resolve) => {
    resolveSetResolution = resolve
  })
  const commits: string[] = []
  const failures: string[] = []

  requestSpotSetResolution({
    chart: {
      setResolution: (_resolution: string, options: SpotSetResolutionOptions) => {
        dataReady = typeof options === 'function' ? options : options?.dataReady
        return setResolutionResult
      },
      resolution: () => '1',
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: (reason: string) => commits.push(reason),
    onFailed: (reason: string) => failures.push(reason),
    clock,
    timeoutMs: 100,
  })

  dataReady?.()
  resolveSetResolution(false)
  await Promise.resolve()
  clock.advanceBy(100)

  assert.deepEqual(commits, ['dataReady'])
  assert.deepEqual(failures, [])
})

test('transport scheduler keeps only one active request and no lifecycle truth', () => {
  const coordinator = new SpotResolutionIntentCoordinator()
  const active = coordinator.request({ sessionId: 'spot:1', intentId: 1, resolution: '1D' })
  const pending = coordinator.request({ sessionId: 'spot:2', intentId: 2, resolution: '1M' })

  assert.equal(active.action, 'start')
  assert.equal(pending.action, 'pending')
  assert.deepEqual(coordinator.snapshot(), {
    activeToken: active.token,
    requestSequence: 1,
  })
  assert.deepEqual(Object.keys(coordinator.snapshot()).sort(), ['activeToken', 'requestSequence'])
})

test('transport scheduler rejects an intent the runtime no longer considers latest', () => {
  const coordinator = new SpotResolutionIntentCoordinator()
  const decision = coordinator.request(
    { sessionId: 'spot:old', intentId: 1, resolution: '5' },
    { isLatest: false },
  )
  assert.equal(decision.action, 'stale')
  assert.equal(decision.snapshot.activeToken, null)
})

test('settling transport does not implicitly start or commit another lifecycle session', () => {
  const coordinator = new SpotResolutionIntentCoordinator()
  const first = coordinator.request({ sessionId: 'spot:1', intentId: 1, resolution: '1D' })
  assert.equal(coordinator.settle(first.token!).accepted, true)
  assert.equal(coordinator.snapshot().activeToken, null)
  const latest = coordinator.request({ sessionId: 'spot:4', intentId: 4, resolution: '1M' })
  assert.equal(latest.action, 'start')
  assert.equal(latest.token?.intentId, 4)
})

test('requesting the same in-flight session is a transport no-op', () => {
  const coordinator = new SpotResolutionIntentCoordinator()
  const intent = { sessionId: 'spot:1', intentId: 1, resolution: '1D' }
  const active = coordinator.request(intent)
  assert.equal(coordinator.request(intent).action, 'noop')
  assert.equal(coordinator.snapshot().activeToken?.requestSequence, active.token?.requestSequence)
})

test('reset invalidates old transport callbacks', () => {
  const coordinator = new SpotResolutionIntentCoordinator()
  const active = coordinator.request({ sessionId: 'spot:1', intentId: 1, resolution: '5' })
  coordinator.reset()
  assert.equal(coordinator.isCurrent(active.token), false)
  assert.equal(coordinator.settle(active.token!).accepted, false)
})

test('transport scheduler preserves TradingView resolution values without normalization', () => {
  const coordinator = new SpotResolutionIntentCoordinator()
  for (const [index, resolution] of ['5', '15', '60', '1D', '1W', '1M'].entries()) {
    const decision = coordinator.request({
      sessionId: `spot:${index + 1}`,
      intentId: index + 1,
      resolution,
    })
    assert.equal(decision.token?.resolution, resolution)
    assert.equal(coordinator.settle(decision.token!).accepted, true)
  }
})

test('initial resolution follows REGISTER then RESOLUTION then SUBSCRIBER then COMMIT', () => {
  const runtime = lifecycleRuntime()
  const initial = runtime.beginIntent({ tradingViewResolution: '1', backendInterval: '1m' })
  assert.equal(initial.decision.reason, 'REGISTERED')
  assert.equal(runtime.applyResolution(initial.identity).reason, 'RESOLUTION_APPLIED')
  assert.equal(runtime.tryCommit(initial.identity).accepted, false)
  assert.equal(runtime.recordSubscriber(subscriberEvidence(initial.identity)).reason, 'SUBSCRIBER_READY')
  assert.equal(runtime.tryCommit(initial.identity).reason, 'COMMITTED')
  assert.equal(runtime.snapshot().committed?.tradingViewResolution, '1')
})

test('subscriber readiness before resolution cannot commit early', () => {
  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  assert.equal(runtime.recordSubscriber(subscriberEvidence(intent.identity)).reason, 'SUBSCRIBER_RECORDED')
  assert.equal(runtime.tryCommit(intent.identity).accepted, false)
  assert.equal(runtime.applyResolution(intent.identity).reason, 'SUBSCRIBER_READY')
  assert.equal(runtime.tryCommit(intent.identity).accepted, true)
})

test('1m to 5m to 1D to 1M commits only the final runtime intent', () => {
  const runtime = lifecycleRuntime()
  const identities = [
    runtime.beginIntent({ tradingViewResolution: '1', backendInterval: '1m' }).identity,
    runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' }).identity,
    runtime.beginIntent({ tradingViewResolution: '1D', backendInterval: '1Dutc' }).identity,
    runtime.beginIntent({ tradingViewResolution: '1M', backendInterval: '1Mutc' }).identity,
  ]
  for (const staleIdentity of identities.slice(0, -1)) {
    assert.equal(runtime.applyResolution(staleIdentity).accepted, false)
    assert.equal(runtime.recordSubscriber(subscriberEvidence(staleIdentity)).accepted, false)
    assert.equal(runtime.tryCommit(staleIdentity).accepted, false)
  }
  const latest = identities.at(-1)!
  runtime.applyResolution(latest)
  runtime.recordSubscriber(subscriberEvidence(latest, 4))
  assert.equal(runtime.tryCommit(latest).accepted, true)
  assert.equal(runtime.snapshot().committed?.tradingViewResolution, '1M')
})

test('old subscriber generation cannot replace the latest readiness evidence', () => {
  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(intent.identity)
  assert.equal(runtime.recordSubscriber(subscriberEvidence(intent.identity, 2)).accepted, true)
  const stale = runtime.recordSubscriber(subscriberEvidence(intent.identity, 1))
  assert.equal(stale.accepted, false)
  assert.equal(stale.reason, 'STALE_SUBSCRIBER')
  assert.equal(runtime.snapshot().candidate?.subscriptionGeneration, 2)
})

test('BTC to ETH to BTC creates independent identities and retires the old symbol', () => {
  const btcOne = lifecycleRuntime()
  const firstBtc = btcOne.beginIntent({ tradingViewResolution: '1', backendInterval: '1m' }).identity
  assert.equal(btcOne.retireAll('SYMBOL_SWITCH').accepted, true)

  const eth = lifecycleRuntime({ widgetGeneration: 2, datafeedInstanceId: 8, symbol: 'ETHUSDT' })
  const ethIdentity = eth.beginIntent({ tradingViewResolution: '1D', backendInterval: '1Dutc' }).identity
  assert.equal(eth.retireAll('SYMBOL_SWITCH').accepted, true)

  const btcTwo = lifecycleRuntime({ widgetGeneration: 3, datafeedInstanceId: 9 })
  const recoveredBtc = btcTwo.beginIntent({ tradingViewResolution: '1', backendInterval: '1m' }).identity
  assert.notEqual(recoveredBtc.sessionId, firstBtc.sessionId)
  assert.notEqual(recoveredBtc.sessionId, ethIdentity.sessionId)
})

test('widget destroy rejects late resolution subscriber and commit callbacks', () => {
  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  assert.equal(runtime.retireAll('WIDGET_DESTROY').accepted, true)
  assert.equal(runtime.applyResolution(intent.identity).accepted, false)
  assert.equal(runtime.recordSubscriber(subscriberEvidence(intent.identity)).accepted, false)
  assert.equal(runtime.tryCommit(intent.identity).accepted, false)
  assert.equal(runtime.snapshot().candidate, null)
  assert.equal(runtime.snapshot().committed, null)
})

test('Spot runtime rearm decision remains one-shot and side-effect free', () => {
  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(intent.identity)
  const first = runtime.requestRearm(intent.identity, 'SUBSCRIBER_MISSING')
  const second = runtime.requestRearm(intent.identity, 'SUBSCRIBER_MISSING')
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, false)
  assert.equal(second.reason, 'REARM_ALREADY_USED')
})

test('observed current resolution without subscriber requests one rearm and waits', () => {
  assert.equal(shouldRequestSpotChartSubscriberRearm({
    resolutionApplied: true,
    subscriberReady: false,
  }), true)
  assert.equal(shouldRequestSpotChartSubscriberRearm({
    resolutionApplied: true,
    subscriberReady: true,
  }), false)
  assert.equal(shouldRequestSpotChartSubscriberRearm({
    resolutionApplied: false,
    subscriberReady: false,
  }), false)

  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  assert.equal(runtime.applyResolution(intent.identity).reason, 'RESOLUTION_APPLIED')
  assert.equal(runtime.tryCommit(intent.identity).accepted, false)
  assert.equal(runtime.requestRearm(intent.identity, 'SUBSCRIBER_MISSING').allowed, true)
  assert.equal(runtime.snapshot().candidate?.state, 'RESOLUTION_APPLIED')
  assert.equal(runtime.snapshot().committed, null)
})

test('subscriber readiness inside the bounded grace commits without requesting rearm', () => {
  const clock = new FakeClock()
  const runtime = lifecycleRuntime()
  const committed = runtime.beginIntent({ tradingViewResolution: '1D', backendInterval: '1d' })
  runtime.applyResolution(committed.identity)
  runtime.recordSubscriber(subscriberEvidence(committed.identity, 10))
  runtime.tryCommit(committed.identity)
  const candidate = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(candidate.identity)
  let subscriberReady = false
  let rearmCalls = 0

  scheduleSpotSubscriberReadinessGrace({
    clock,
    isCurrent: () => runtime.snapshot().candidate?.sessionId === candidate.identity.sessionId,
    isSubscriberReady: () => {
      if (!subscriberReady) return false
      runtime.recordSubscriber(subscriberEvidence(candidate.identity, 11))
      runtime.tryCommit(candidate.identity)
      return true
    },
    onExpired: () => { rearmCalls += 1 },
  })

  clock.advanceBy(SPOT_SUBSCRIBER_READINESS_GRACE_MS - 1)
  assert.equal(runtime.snapshot().committed?.sessionId, committed.identity.sessionId)
  subscriberReady = true
  clock.advanceBy(1)
  assert.equal(rearmCalls, 0)
  assert.equal(runtime.snapshot().committed?.sessionId, candidate.identity.sessionId)
})

test('missing subscriber requests rearm only after the bounded grace expires', () => {
  const clock = new FakeClock()
  const runtime = lifecycleRuntime()
  const candidate = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(candidate.identity)
  const decisions: string[] = []

  scheduleSpotSubscriberReadinessGrace({
    clock,
    isCurrent: () => true,
    isSubscriberReady: () => false,
    onExpired: () => {
      decisions.push(runtime.requestRearm(candidate.identity, 'SUBSCRIBER_MISSING').reason)
    },
  })

  clock.advanceBy(SPOT_SUBSCRIBER_READINESS_GRACE_MS - 1)
  assert.deepEqual(decisions, [])
  clock.advanceBy(1)
  assert.deepEqual(decisions, ['REARM_ALLOWED'])
})

test('rearm recovery timeout retires only the candidate and preserves the old commit', () => {
  const clock = new FakeClock()
  const runtime = lifecycleRuntime()
  const oldCommit = runtime.beginIntent({ tradingViewResolution: '1D', backendInterval: '1d' })
  runtime.applyResolution(oldCommit.identity)
  runtime.recordSubscriber(subscriberEvidence(oldCommit.identity, 20))
  runtime.tryCommit(oldCommit.identity)
  const candidate = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(candidate.identity)
  let resetCacheCalls = 0
  let resetDataCalls = 0

  const waitAfterRearm = () => scheduleSpotSubscriberReadinessGrace({
    clock,
    isCurrent: () => runtime.snapshot().candidate?.sessionId === candidate.identity.sessionId,
    isSubscriberReady: () => false,
    onExpired: () => runtime.retireSession(candidate.identity, 'SUBSCRIBER_TIMEOUT'),
  })
  scheduleSpotSubscriberReadinessGrace({
    clock,
    isCurrent: () => true,
    isSubscriberReady: () => false,
    onExpired: () => {
      const rearm = runtime.requestRearm(candidate.identity, 'SUBSCRIBER_MISSING')
      if (!rearm.allowed || !rearm.permit) return
      resetCacheCalls += 1
      resetDataCalls += 1
      runtime.recordResetExecution(
        candidate.identity,
        'SUBSCRIBER_MISSING',
        true,
        'RESET_EXECUTED',
      )
      waitAfterRearm()
    },
  })

  clock.advanceBy(SPOT_SUBSCRIBER_READINESS_GRACE_MS)
  assert.equal(resetCacheCalls, 1)
  assert.equal(resetDataCalls, 1)
  assert.equal(runtime.snapshot().candidate?.sessionId, candidate.identity.sessionId)
  clock.advanceBy(SPOT_SUBSCRIBER_READINESS_GRACE_MS)
  assert.equal(runtime.snapshot().candidate, null)
  assert.equal(runtime.snapshot().committed?.sessionId, oldCommit.identity.sessionId)
})

test('subscriber generation created after rearm completes the current resolution lifecycle', () => {
  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(intent.identity)
  assert.equal(runtime.requestRearm(intent.identity, 'SUBSCRIBER_MISSING').allowed, true)
  assert.equal(runtime.recordSubscriber(subscriberEvidence(intent.identity, 2)).reason, 'SUBSCRIBER_READY')
  assert.equal(runtime.tryCommit(intent.identity).reason, 'COMMITTED')
  assert.equal(runtime.snapshot().committed?.subscriptionGeneration, 2)
})

test('reset executor completion does not advance a candidate without subscriber readiness', () => {
  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(intent.identity)
  const permit = runtime.requestRearm(intent.identity, 'SUBSCRIBER_MISSING')
  let resetDataCalls = 0

  assert.equal(permit.allowed, true)
  if (permit.permit) {
    resetDataCalls += 1
    runtime.recordResetExecution(
      intent.identity,
      'SUBSCRIBER_MISSING',
      true,
      'RESET_EXECUTED',
    )
  }

  assert.equal(resetDataCalls, 1)
  assert.equal(runtime.snapshot().candidate?.state, 'RESOLUTION_APPLIED')
  assert.equal(runtime.snapshot().candidate?.subscriberUid, null)
  assert.equal(runtime.snapshot().committed, null)
  assert.equal(runtime.tryCommit(intent.identity).reason, 'COMMIT_NOT_READY')
})

test('changed resolution uses the same post-resolution missing-subscriber barrier', () => {
  assert.equal(shouldRequestSpotChartSubscriberRearm({
    resolutionApplied: true,
    subscriberReady: false,
  }), true)

  const runtime = lifecycleRuntime()
  const intent = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  assert.equal(intent.decision.reason, 'REGISTERED')
  assert.equal(runtime.applyResolution(intent.identity).reason, 'RESOLUTION_APPLIED')
  assert.equal(runtime.recordSubscriber(subscriberEvidence(intent.identity, 20)).reason, 'SUBSCRIBER_READY')
  assert.equal(runtime.tryCommit(intent.identity).reason, 'COMMITTED')
})

test('normal async 1M to 5m completion rearms once before the new subscriber commits', () => {
  const clock = new FakeClock()
  const runtime = lifecycleRuntime()
  const monthly = runtime.beginIntent({ tradingViewResolution: '1M', backendInterval: '1Mutc' })
  runtime.applyResolution(monthly.identity)
  runtime.recordSubscriber(subscriberEvidence(monthly.identity, 19))
  assert.equal(runtime.tryCommit(monthly.identity).accepted, true)

  const fiveMinutes = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  let actualResolution = '1M'
  let dataReady: (() => void) | undefined
  let resetExecutions = 0

  requestSpotSetResolution({
    chart: {
      setResolution: (resolution: string, options: SpotSetResolutionOptions) => {
        actualResolution = resolution
        dataReady = typeof options === 'function' ? options : options?.dataReady
      },
      resolution: () => actualResolution,
    },
    resolution: '5',
    isCurrent: () => true,
    onCommitted: () => {
      const resolutionDecision = runtime.applyResolution(fiveMinutes.identity)
      if (shouldRequestSpotChartSubscriberRearm({
        resolutionApplied: resolutionDecision.accepted,
        subscriberReady: false,
      })) {
        scheduleSpotSubscriberReadinessGrace({
          clock,
          isCurrent: () => true,
          isSubscriberReady: () => false,
          onExpired: () => {
            const rearm = runtime.requestRearm(fiveMinutes.identity, 'SUBSCRIBER_MISSING')
            if (rearm.allowed && rearm.permit) resetExecutions += 1
          },
        })
      }
    },
    onFailed: assert.fail,
    clock,
  })

  dataReady?.()
  assert.equal(actualResolution, '5')
  assert.equal(resetExecutions, 0)
  clock.advanceBy(SPOT_SUBSCRIBER_READINESS_GRACE_MS)
  assert.equal(resetExecutions, 1)
  assert.equal(runtime.snapshot().candidate?.state, 'RESOLUTION_APPLIED')
  assert.equal(runtime.snapshot().committed?.sessionId, monthly.identity.sessionId)
  assert.equal(
    runtime.requestRearm(fiveMinutes.identity, 'SUBSCRIBER_MISSING').reason,
    'REARM_ALREADY_USED',
  )

  assert.equal(
    runtime.recordSubscriber(subscriberEvidence(fiveMinutes.identity, 20)).reason,
    'SUBSCRIBER_READY',
  )
  assert.equal(runtime.tryCommit(fiveMinutes.identity).reason, 'COMMITTED')
  assert.equal(runtime.snapshot().committed?.tradingViewResolution, '5')
  assert.equal(runtime.snapshot().committed?.subscriptionGeneration, 20)
})

test('rapid 1M to 5m keeps old commit until rearmed subscriber commits the latest intent', () => {
  const runtime = lifecycleRuntime()
  const monthly = runtime.beginIntent({ tradingViewResolution: '1M', backendInterval: '1Mutc' })
  runtime.applyResolution(monthly.identity)
  runtime.recordSubscriber(subscriberEvidence(monthly.identity, 19))
  assert.equal(runtime.tryCommit(monthly.identity).accepted, true)

  const fiveMinutes = runtime.beginIntent({ tradingViewResolution: '5', backendInterval: '5m' })
  runtime.applyResolution(fiveMinutes.identity)
  assert.equal(runtime.requestRearm(fiveMinutes.identity, 'SUBSCRIBER_MISSING').allowed, true)
  assert.equal(runtime.tryCommit(fiveMinutes.identity).accepted, false)
  assert.equal(runtime.snapshot().committed?.sessionId, monthly.identity.sessionId)
  assert.equal(runtime.snapshot().committed?.tradingViewResolution, '1M')

  runtime.recordSubscriber(subscriberEvidence(fiveMinutes.identity, 20))
  assert.equal(runtime.tryCommit(fiveMinutes.identity).accepted, true)
  assert.equal(runtime.snapshot().committed?.sessionId, fiveMinutes.identity.sessionId)
  assert.equal(runtime.snapshot().committed?.tradingViewResolution, '5')
})

test('Spot chart uses Runtime Coordinator as its only lifecycle commit authority', () => {
  const chartSource = readFileSync(
    fileURLToPath(new URL('../SpotTradingViewChart.tsx', import.meta.url)),
    'utf8',
  )

  assert.match(chartSource, /new KlineLifecycleRuntimeCoordinator/)
  assert.match(chartSource, /runtimeCoordinator\.beginIntent/)
  assert.match(chartSource, /activeRuntime\.applyResolution/)
  assert.match(chartSource, /runtimeCoordinator\.recordSubscriber/)
  assert.match(chartSource, /runtimeCoordinator\.tryCommit/)
  assert.match(chartSource, /shouldRequestSpotChartSubscriberRearm/)
  assert.match(chartSource, /const postResolutionBarrierCheck =/)
  assert.match(
    chartSource,
    /onCommitted:[\s\S]{0,400}postResolutionBarrierCheck\(reason/,
  )
  assert.match(chartSource, /postResolutionBarrierCheck\('already current resolution'\)/)
  assert.match(chartSource, /runtimeCoordinator\.requestRearm\(identity, 'SUBSCRIBER_MISSING'\)/)
  assert.match(chartSource, /scheduleSpotSubscriberReadinessGrace/)
  assert.match(chartSource, /activeRuntime\.retireSession\(identity, 'SUBSCRIBER_TIMEOUT'\)/)
  assert.ok(chartSource.indexOf('chart.resetCache();') < chartSource.indexOf('chart.resetData();'))
  assert.match(chartSource, /chart\.resetCache\(\)/)
  assert.match(chartSource, /chart\.resetData\(\)/)
  assert.match(chartSource, /bootstrapKlineLifecycleObservability\(\)/)
  assert.doesNotMatch(chartSource, /syncRealtimeKlineSubscription/)
  assert.match(chartSource, /if \(subscriberReady\) tryCommitRuntimeCandidate/)
  assert.match(chartSource, /recordRealtimeSubscriptionReadiness/)
  assert.doesNotMatch(chartSource, /commitLifecycle\(/)
  assert.doesNotMatch(chartSource, /registerLifecycleSession/)
  assert.doesNotMatch(chartSource, /committedResolutionRef/)
  assert.match(chartSource, /'SYMBOL_SWITCH'/)
  assert.match(chartSource, /'WIDGET_DESTROY'/)
})
