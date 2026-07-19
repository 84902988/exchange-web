export type ContractPrivateRefreshDecision = 'START' | 'COALESCED';

/**
 * Keeps private REST refreshes single-flight without dropping structural events.
 * Repeated requests for the same visible scope collapse into one trailing replay.
 */
export class ContractPrivateRefreshCoordinator {
  private readonly activeKeys = new Set<string>();
  private readonly pendingKeys = new Set<string>();

  request(key: string): ContractPrivateRefreshDecision {
    if (this.activeKeys.has(key)) {
      this.pendingKeys.add(key);
      return 'COALESCED';
    }
    this.activeKeys.add(key);
    return 'START';
  }

  settle(key: string): boolean {
    this.activeKeys.delete(key);
    return this.pendingKeys.delete(key);
  }

  /**
   * A realtime structural event can invalidate an in-flight REST response even
   * when it belongs to another private domain. Retain exactly one trailing
   * replay for every active scope so the visible state cannot remain stale.
   */
  replayActive() {
    this.activeKeys.forEach((key) => this.pendingKeys.add(key));
  }

  reset() {
    this.activeKeys.clear();
    this.pendingKeys.clear();
  }
}
