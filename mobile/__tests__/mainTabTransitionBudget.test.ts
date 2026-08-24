import {
  MAIN_TAB_TRANSITION_BUDGET_MS,
  __resetMainTabTransitionBudgetForTests,
  beginMainTabTransitionBudget,
  shouldYieldRealtimeForMainTabTransition,
} from '../src/performance/mainTabTransitionBudget';

describe('mainTabTransitionBudget', () => {
  afterEach(() => {
    __resetMainTabTransitionBudgetForTests();
  });

  it('yields high-frequency display work only inside the bounded window', () => {
    beginMainTabTransitionBudget(1_000);

    expect(shouldYieldRealtimeForMainTabTransition(1_000)).toBe(true);
    expect(
      shouldYieldRealtimeForMainTabTransition(
        1_000 + MAIN_TAB_TRANSITION_BUDGET_MS - 1,
      ),
    ).toBe(true);
    expect(
      shouldYieldRealtimeForMainTabTransition(
        1_000 + MAIN_TAB_TRANSITION_BUDGET_MS,
      ),
    ).toBe(false);
  });

  it('extends an active budget instead of shortening it', () => {
    beginMainTabTransitionBudget(1_000);
    beginMainTabTransitionBudget(1_100);

    expect(shouldYieldRealtimeForMainTabTransition(1_499)).toBe(true);
    expect(shouldYieldRealtimeForMainTabTransition(1_500)).toBe(false);
  });
});
