import React from 'react';
import AppRoot from './src/app/AppRoot';
import AppErrorBoundary from './src/app/AppErrorBoundary';

export default function App() {
  return (
    <AppErrorBoundary>
      <AppRoot />
    </AppErrorBoundary>
  );
}
