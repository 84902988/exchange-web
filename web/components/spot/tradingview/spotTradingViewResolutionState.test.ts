import assert from 'node:assert/strict'
import test from 'node:test'
import {
  requestSpotSetResolution,
  setSpotToolbarDisabled,
  SpotChartLoadingCoordinator,
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
    onSettled: (sequence) => settled.push(sequence),
  })

  for (const interval of ['1m', '1D', '1W', '1M', '1m']) {
    const sequence = coordinator.start(interval)
    assert.equal(coordinator.finish(sequence), true)
    assert.equal(coordinator.finish(sequence), false)
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

  const emptySequence = coordinator.start('RCBUSDT:4H:empty')
  assert.equal(coordinator.finish(emptySequence), true)
  clock.advanceBy(220)
  const nextSequence = coordinator.start('BTCUSDT:1D')
  assert.equal(nextSequence, emptySequence + 1)
  assert.equal(coordinator.finish(nextSequence), true)
  clock.advanceBy(220)

  assert.deepEqual(changes, ['RCBUSDT:4H:empty', '', 'BTCUSDT:1D', ''])
})

test('toolbar aria-disabled is present only during a real switch', () => {
  const slot = fakeElement()
  const button = fakeElement()
  const buttons = new Map([['1M', button]])

  setSpotToolbarDisabled(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    true,
  )
  assert.equal(slot.attributes.get('aria-disabled'), 'true')
  assert.equal(button.attributes.get('aria-disabled'), 'true')
  assert.equal(button.disabled, true)
  assert.equal(button.tabIndex, -1)

  setSpotToolbarDisabled(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    false,
  )
  assert.equal(slot.attributes.has('aria-disabled'), false)
  assert.equal(button.attributes.has('aria-disabled'), false)
  assert.equal(button.disabled, false)
  assert.equal(button.tabIndex, 0)
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
    onSettled: () => setSpotToolbarDisabled(
      slot as unknown as HTMLElement,
      buttons as unknown as Map<string, HTMLButtonElement>,
      false,
    ),
  })
  const loadingSequence = coordinator.start('1D')
  setSpotToolbarDisabled(
    slot as unknown as HTMLElement,
    buttons as unknown as Map<string, HTMLButtonElement>,
    true,
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
      coordinator.finish(loadingSequence)
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

test('dataReady cannot commit a highlight that contradicts chart resolution', () => {
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
  assert.equal(highlightedInterval, '1m')
  assert.deepEqual(failures, ['setResolution commit mismatch'])
})
