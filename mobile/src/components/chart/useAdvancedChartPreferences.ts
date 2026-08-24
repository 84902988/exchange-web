import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AdvancedChartIndicator } from './advancedChartIndicators';
import {
  cloneAdvancedChartPreferences,
  configFromPreferences,
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  mergeConfigIntoPreferences,
  type AdvancedChartIndicatorConfigV2,
  type AdvancedChartPreferencesV2,
} from './advancedChartConfig';
import {
  readAdvancedChartPreferences,
  writeAdvancedChartPreferences,
} from './advancedChartPreferences';

function samePreferences(
  left: AdvancedChartPreferencesV2,
  right: AdvancedChartPreferencesV2,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useAdvancedChartPreferences() {
  const [preferences, setPreferences] = useState<AdvancedChartPreferencesV2>(
    () => cloneAdvancedChartPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES),
  );
  const [hydrated, setHydrated] = useState(false);
  const preferencesRef = useRef(preferences);
  const committedRef = useRef(preferences);
  const localMutationSequenceRef = useRef(0);
  const readPendingRef = useRef(true);
  const automaticWriteProtectedRef = useRef(false);
  const pendingConfirmationRef = useRef<AdvancedChartPreferencesV2 | null>(
    null,
  );
  preferencesRef.current = preferences;

  useEffect(() => {
    let active = true;
    const startedAtMutation = localMutationSequenceRef.current;
    const timeout = setTimeout(() => {
      if (!active) return;
      setHydrated(true);
    }, 800);
    readAdvancedChartPreferences().then(
      result => {
        if (!active) return;
        clearTimeout(timeout);
        readPendingRef.current = false;
        const hasLocalMutation =
          localMutationSequenceRef.current !== startedAtMutation;
        if (!hasLocalMutation) {
          automaticWriteProtectedRef.current = result.writeProtected;
          if (result.status === 'valid') {
            const restored = result.preferences;
            pendingConfirmationRef.current = null;
            preferencesRef.current = restored;
            committedRef.current = restored;
            setPreferences(current =>
              samePreferences(current, restored) ? current : restored,
            );
          } else if (result.writeProtected) {
            pendingConfirmationRef.current = null;
          } else if (pendingConfirmationRef.current) {
            const confirmed = pendingConfirmationRef.current;
            pendingConfirmationRef.current = null;
            writeAdvancedChartPreferences(confirmed);
          }
        } else {
          // A real local edit owns this epoch and explicitly permits V2 migration.
          automaticWriteProtectedRef.current = false;
          pendingConfirmationRef.current = null;
        }
        setHydrated(true);
      },
      () => {
        if (!active) return;
        clearTimeout(timeout);
        readPendingRef.current = false;
        automaticWriteProtectedRef.current =
          localMutationSequenceRef.current === startedAtMutation;
        pendingConfirmationRef.current = null;
        setHydrated(true);
      },
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, []);

  const mutate = useCallback(
    (
      operation: (
        current: AdvancedChartPreferencesV2,
      ) => AdvancedChartPreferencesV2,
    ) => {
      const current = preferencesRef.current;
      const next = operation(current);
      if (samePreferences(current, next)) return false;
      localMutationSequenceRef.current += 1;
      automaticWriteProtectedRef.current = false;
      pendingConfirmationRef.current = null;
      preferencesRef.current = next;
      setPreferences(rendered =>
        samePreferences(rendered, next) ? rendered : next,
      );
      return true;
    },
    [],
  );

  const persistConfirmation = useCallback(
    (confirmed: AdvancedChartPreferencesV2) => {
      if (
        localMutationSequenceRef.current === 0 &&
        (readPendingRef.current || automaticWriteProtectedRef.current)
      ) {
        pendingConfirmationRef.current = confirmed;
        return;
      }
      pendingConfirmationRef.current = null;
      writeAdvancedChartPreferences(confirmed);
    },
    [],
  );

  const selectIndicator = useCallback(
    (indicator: AdvancedChartIndicator) => {
      return mutate(current => {
        if (
          current.selection.overlay === indicator ||
          current.selection.pane === indicator
        ) {
          return current;
        }
        const selection =
          indicator === 'MA' ||
          indicator === 'EMA' ||
          indicator === 'BOLL' ||
          indicator === 'SAR' ||
          indicator === 'AVL' ||
          indicator === 'SUPER'
            ? { ...current.selection, overlay: indicator }
            : { ...current.selection, pane: indicator };
        return { ...current, selection };
      });
    },
    [mutate],
  );

  const applyConfig = useCallback(
    (config: AdvancedChartIndicatorConfigV2) => {
      mutate(current => mergeConfigIntoPreferences(current, config));
    },
    [mutate],
  );

  const commitPreferences = useCallback(
    (next: AdvancedChartPreferencesV2) => {
      const changed = !samePreferences(preferencesRef.current, next);
      const canonical = changed
        ? cloneAdvancedChartPreferences(next)
        : preferencesRef.current;
      if (changed) {
        localMutationSequenceRef.current += 1;
        automaticWriteProtectedRef.current = false;
        pendingConfirmationRef.current = null;
      }
      preferencesRef.current = canonical;
      committedRef.current = canonical;
      setPreferences(current =>
        samePreferences(current, canonical) ? current : canonical,
      );
      persistConfirmation(canonical);
    },
    [persistConfirmation],
  );

  const commitConfig = useCallback(
    (config: AdvancedChartIndicatorConfigV2) => {
      commitPreferences(
        mergeConfigIntoPreferences(preferencesRef.current, config),
      );
    },
    [commitPreferences],
  );

  const commitSelection = useCallback(
    (selection: AdvancedChartPreferencesV2['selection']) => {
      const next = { ...preferencesRef.current, selection };
      const canonical = samePreferences(preferencesRef.current, next)
        ? preferencesRef.current
        : next;
      preferencesRef.current = canonical;
      committedRef.current = canonical;
      setPreferences(current =>
        samePreferences(current, canonical) ? current : canonical,
      );
      persistConfirmation(canonical);
    },
    [persistConfirmation],
  );

  const selectNativeIndicator = useCallback(
    (indicator: AdvancedChartIndicator) => {
      if (!selectIndicator(indicator)) return;
      commitSelection(preferencesRef.current.selection);
    },
    [commitSelection, selectIndicator],
  );

  const handleConfigError = useCallback(
    (actual: AdvancedChartIndicatorConfigV2 | null) => {
      if (actual) {
        commitConfig(actual);
        return;
      }
      const rollback = committedRef.current;
      preferencesRef.current = rollback;
      setPreferences(rollback);
    },
    [commitConfig],
  );

  const handleSelectionError = useCallback(
    (actual: AdvancedChartPreferencesV2['selection'] | null) => {
      if (actual) {
        commitSelection(actual);
        return;
      }
      const rollback = committedRef.current;
      preferencesRef.current = rollback;
      setPreferences(rollback);
    },
    [commitSelection],
  );

  const config = useMemo(
    () => configFromPreferences(preferences),
    [preferences],
  );

  return {
    config,
    hydrated,
    preferences,
    selection: preferences.selection,
    applyConfig,
    commitConfig,
    commitPreferences,
    commitSelection,
    handleConfigError,
    handleSelectionError,
    selectIndicator,
    selectNativeIndicator,
  };
}
