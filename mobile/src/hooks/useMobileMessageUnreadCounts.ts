import {startTransition, useCallback, useRef, useState} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {
  fetchMobileMessageUnreadCounts,
  type MobileMessageUnreadCounts,
} from '../api/mobileContent';

type State = {
  counts: MobileMessageUnreadCounts | null;
  loading: boolean;
  error: string | null;
};

const LOGGED_OUT_STATE: State = {
  counts: null,
  loading: false,
  error: null,
};

export function useMobileMessageUnreadCounts(isLoggedIn: boolean) {
  const generationRef = useRef(0);
  const [state, setState] = useState<State>(LOGGED_OUT_STATE);

  useFocusEffect(
    useCallback(() => {
      const generation = ++generationRef.current;
      if (!isLoggedIn) {
        setState(LOGGED_OUT_STATE);
        return () => {
          generationRef.current += 1;
        };
      }

      const controller = new AbortController();
      setState(previous => ({...previous, loading: true, error: null}));
      fetchMobileMessageUnreadCounts({signal: controller.signal})
        .then(counts => {
          if (controller.signal.aborted || generation !== generationRef.current) {
            return;
          }
          startTransition(() => {
            setState({counts, loading: false, error: null});
          });
        })
        .catch(() => {
          if (controller.signal.aborted || generation !== generationRef.current) {
            return;
          }
          startTransition(() => {
            setState({
              counts: null,
              loading: false,
              error: '消息未读状态暂不可用',
            });
          });
        });

      return () => {
        controller.abort();
        if (generationRef.current === generation) {
          generationRef.current += 1;
        }
      };
    }, [isLoggedIn]),
  );

  return {
    ...state,
    hasUnread: Boolean(state.counts && state.counts.total > 0),
  };
}
