import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../store/authStore';
import {
  getCachedAssetSnapshot,
  isAssetSnapshotExpired,
  loadAssetSnapshot,
  normalizeAssetSnapshotUserId,
  type AssetSnapshot,
} from '../services/assetSnapshot';

type AssetSnapshotState = {
  userId: string | null;
  snapshot: AssetSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
};

export function useAssetSnapshot() {
  const { loading: authLoading, user } = useAuth();
  const userId = getAssetSnapshotUserId(user?.id);
  const generationRef = useRef(0);
  const forceReloadRef = useRef(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [state, setState] = useState<AssetSnapshotState>(() =>
    createStateForUser(userId, authLoading),
  );

  useEffect(() => {
    generationRef.current += 1;
    setState(createStateForUser(userId, authLoading));
  }, [authLoading, userId]);

  useFocusEffect(
    useCallback(() => {
      if (!userId || authLoading) {
        return undefined;
      }

      const generation = ++generationRef.current;
      const cached = getCachedAssetSnapshot(userId);
      let active = true;
      setState({
        userId,
        snapshot: cached,
        loading: !cached,
        refreshing: Boolean(cached),
        stale: cached ? isAssetSnapshotExpired(cached) : false,
        error: null,
      });

      const force = reloadRevision > 0 && forceReloadRef.current;
      forceReloadRef.current = false;
      loadAssetSnapshot({ userId, force }).then(result => {
        if (
          !active ||
          generation !== generationRef.current ||
          (result.snapshot !== null && result.snapshot.userId !== userId)
        ) {
          return;
        }
        startTransition(() => {
          setState({
            userId,
            snapshot: result.snapshot,
            loading: false,
            refreshing: false,
            stale:
              result.source === 'stale-cache' ||
              Boolean(
                result.snapshot && isAssetSnapshotExpired(result.snapshot),
              ),
            error: result.error,
          });
        });
      });

      return () => {
        active = false;
        if (generationRef.current === generation) {
          generationRef.current += 1;
        }
      };
    }, [authLoading, reloadRevision, userId]),
  );

  const reload = useCallback(() => {
    if (!userId || authLoading) return;
    forceReloadRef.current = true;
    setReloadRevision(current => current + 1);
  }, [authLoading, userId]);

  if (state.userId !== userId) {
    return { ...createStateForUser(userId, authLoading), reload };
  }
  return { ...state, reload };
}

export function getAssetSnapshotUserId(value: unknown) {
  return normalizeAssetSnapshotUserId(value) || null;
}

function createStateForUser(
  userId: string | null,
  authLoading: boolean,
): AssetSnapshotState {
  const cached = userId ? getCachedAssetSnapshot(userId) : null;
  return {
    userId,
    snapshot: cached,
    loading: authLoading || Boolean(userId && !cached),
    refreshing: false,
    stale: cached ? isAssetSnapshotExpired(cached) : false,
    error: null,
  };
}
