export const MAIN_TAB_TRANSITION_BUDGET_MS = 400;

let yieldRealtimeUntilMs = 0;

/**
 * Gives a main-tab navigation update a short, deterministic JS window before
 * public display frames resume. Connection state and expiry timers are not
 * paused; only high-frequency market payload work consults this budget.
 */
export function beginMainTabTransitionBudget(nowMs = Date.now()) {
  yieldRealtimeUntilMs = Math.max(
    yieldRealtimeUntilMs,
    nowMs + MAIN_TAB_TRANSITION_BUDGET_MS,
  );
}

export function shouldYieldRealtimeForMainTabTransition(
  nowMs = Date.now(),
) {
  return nowMs < yieldRealtimeUntilMs;
}

export function __resetMainTabTransitionBudgetForTests() {
  yieldRealtimeUntilMs = 0;
}
