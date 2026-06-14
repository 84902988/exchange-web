import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import assetReducer from './assetSlice';

// 导出类型定义
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// 导出自定义 hooks
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

// 创建 store
const store = configureStore({
  reducer: {
    asset: assetReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // 忽略的 action 路径
        ignoredActions: ['your/action/type'],
        // 忽略的状态路径
        ignoredPaths: ['some.nested.path'],
      },
    }),
});

export default store;
