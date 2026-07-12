import assert from 'node:assert/strict'
import test from 'node:test'
import {
  requestSpotSetResolution,
  setSpotToolbarLoadingState,
  shouldStartSpotChartResolutionChange,
  SpotChartLoadingCoordinator,
  SpotResolutionIntentCoordinator,
  type SpotChartLoadingClock,
} from './spotTradingViewResolutionState.ts'

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
    onChange: (reason) => changes.push(reason),
    onSettled: (token) => settled.push(token.sequence),
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
    onChange: (reason) => changes.push(reason),
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
    onChange: (reason) => changes.push(reason),
    onSettled: (token) => settled.push({
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
    onChange: (reason) => changes.push(reason),
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
    currentResolution: '1M',
    nextResolution: '1M',
  }), false)
  assert.equal(shouldStartSpotChartResolutionChange({
    widgetAvailable: true,
    chartReady: false,
    currentResolution: '1D',
    nextResolution: '1M',
  }), false)
  assert.equal(shouldStartSpotChartResolutionChange({
    widgetAvailable: true,
    chartReady: true,
    currentResolution: '1D',
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
    onSettled: (token) => settled.push(token.sequence),
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
    onChange: (reason) => changes.push(reason),
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
      setResolution: (resolution, options) => {
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
      setResolution: (_resolution, options) => {
        dataReady = typeof options === 'function' ? options : options?.dataReady
      },
      resolution: () => '1',
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: () => {
      highlightedInterval = '1M'
    },
    onFailed: (reason) => failures.push(reason),
    clock,
  })

  dataReady?.()
  assert.equal(highlightedInterval, '1M')
  assert.deepEqual(failures, [])
})

test('dataReady commits once and late promise or timeout cannot roll it back', async () => {
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
      setResolution: (_resolution, options) => {
        dataReady = typeof options === 'function' ? options : options?.dataReady
        return setResolutionResult
      },
      resolution: () => '1',
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: (reason) => commits.push(reason),
    onFailed: (reason) => failures.push(reason),
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

test('loading keeps only intent12 after 1M intent10, 5m intent11, 1M intent12', () => {
  const coordinator = new SpotResolutionIntentCoordinator('1', 8)
  const loadingIntent = coordinator.registerIntent('1D')
  assert.equal(loadingIntent.intent.intentId, 9)
  const loading = coordinator.request(loadingIntent.intent)
  assert.equal(loading.action, 'start')

  const intent10 = coordinator.registerIntent('1M')
  assert.equal(intent10.intent.intentId, 10)
  assert.equal(coordinator.request(intent10.intent).action, 'pending')
  const intent11 = coordinator.registerIntent('5')
  assert.equal(intent11.intent.intentId, 11)
  assert.equal(coordinator.request(intent11.intent).action, 'pending')
  const intent12 = coordinator.registerIntent('1M')
  assert.equal(intent12.intent.intentId, 12)
  assert.equal(coordinator.request(intent12.intent).action, 'pending')

  assert.deepEqual(coordinator.snapshot().pendingResolution, {
    resolution: '1M',
    intentId: 12,
  })
  const settlement = coordinator.commit(loading.token!)
  assert.equal(settlement.accepted, true)
  assert.deepEqual(settlement.nextToken, {
    resolution: '1M',
    intentId: 12,
    requestSequence: 2,
  })
})

test('dataReady in the intent propagation window cannot drain or apply an older pending intent', () => {
  const coordinator = new SpotResolutionIntentCoordinator('1', 8)
  const loadingIntent = coordinator.registerIntent('1D').intent
  const loading = coordinator.request(loadingIntent)

  const oldPending = coordinator.registerIntent('1M').intent
  assert.equal(oldPending.intentId, 10)
  assert.equal(coordinator.request(oldPending).action, 'pending')

  // The toolbar has synchronously recorded the newer click, but its React prop/effect
  // has not reached applyWidgetResolution yet when the current dataReady fires.
  const latestPending = coordinator.registerIntent('5').intent
  assert.equal(latestPending.intentId, 11)
  const settlement = coordinator.commit(loading.token!)

  assert.equal(settlement.nextToken?.resolution, '5')
  assert.equal(settlement.nextToken?.intentId, 11)
  assert.equal(coordinator.request(oldPending).action, 'stale')
  assert.deepEqual(coordinator.snapshot().pendingResolution, null)
  assert.equal(coordinator.snapshot().inFlightResolution, '5')
})

test('nine rapid resolution clicks start only the final clicked resolution after the active request', () => {
  const coordinator = new SpotResolutionIntentCoordinator('1')
  const activeIntent = coordinator.registerIntent('1D').intent
  const active = coordinator.request(activeIntent)
  const startedResolutions = [active.token!.resolution]

  for (const resolution of ['1', '5', '15', '60', '1D', '1W', '1M', '5', '1M']) {
    const intent = coordinator.registerIntent(resolution).intent
    coordinator.request(intent)
  }

  const settlement = coordinator.commit(active.token!)
  if (settlement.nextToken) startedResolutions.push(settlement.nextToken.resolution)

  assert.deepEqual(startedResolutions, ['1D', '1M'])
  assert.equal(settlement.nextToken?.intentId, coordinator.snapshot().latestIntentId)
})

test('clicking the in-flight resolution clears only that latest intent', () => {
  const coordinator = new SpotResolutionIntentCoordinator('1')
  const currentIntent = coordinator.registerIntent('1D').intent
  const current = coordinator.request(currentIntent)
  const oldPending = coordinator.registerIntent('1M').intent
  assert.equal(coordinator.request(oldPending).action, 'pending')

  const backToInFlight = coordinator.registerIntent('1D').intent
  assert.equal(coordinator.request(backToInFlight).action, 'noop')
  assert.equal(coordinator.snapshot().pendingResolution, null)

  assert.equal(coordinator.request(oldPending).action, 'stale')
  assert.equal(coordinator.snapshot().pendingResolution, null)
  const settlement = coordinator.commit(current.token!)
  assert.equal(settlement.nextToken, undefined)
  assert.equal(settlement.snapshot.currentResolution, '1D')
})

test('stale resolution token cannot commit clear pending or replace the active request', () => {
  const coordinator = new SpotResolutionIntentCoordinator('1')
  const oldIntent = coordinator.registerIntent('1D').intent
  const oldRequest = coordinator.request(oldIntent).token!
  const monthlyIntent = coordinator.registerIntent('1M').intent
  coordinator.request(monthlyIntent)
  const oldCommit = coordinator.commit(oldRequest)
  const currentRequest = oldCommit.nextToken!
  const weeklyIntent = coordinator.registerIntent('1W').intent
  coordinator.request(weeklyIntent)

  assert.equal(coordinator.commit(oldRequest).accepted, false)
  assert.equal(coordinator.fail(oldRequest).accepted, false)
  assert.deepEqual(coordinator.snapshot(), {
    currentResolution: '1D',
    inFlightResolution: '1M',
    pendingResolution: weeklyIntent,
    latestIntentId: weeklyIntent.intentId,
    requestSequence: currentRequest.requestSequence,
  })

  coordinator.reset('5')
  assert.equal(coordinator.commit(currentRequest).accepted, false)
  assert.equal(coordinator.snapshot().currentResolution, '5')
})

test('daily weekly monthly and intraday resolutions commit without normalization loss', () => {
  const coordinator = new SpotResolutionIntentCoordinator('1')
  for (const resolution of ['5', '15', '60', '1D', '1W', '1M']) {
    const intent = coordinator.registerIntent(resolution).intent
    const decision = coordinator.request(intent)
    assert.equal(decision.action, 'start')
    assert.equal(coordinator.commit(decision.token!).accepted, true)
    assert.equal(coordinator.snapshot().currentResolution, resolution)
  }
})
