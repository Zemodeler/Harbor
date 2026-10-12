import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

/** Shown when the Electron preload bridge is missing: Harbor must never silently fall back to sample data. */
function MissingBridge() {
  return <div role="alert" style={{ padding: 32, maxWidth: 560, margin: '10vh auto', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
    <h1 tabIndex={-1} style={{ fontSize: 22 }}>Harbor cannot reach its background service</h1>
    <p>The connection between this window and Harbor is missing, so nothing here would be real. Close Harbor and start it again. If this keeps happening, reinstall it.</p>
  </div>;
}

/** The sample-data mock is for development and for an explicit `?demo` preview only; a packaged build never installs it. */
const demo = import.meta.env.DEV || new URLSearchParams(window.location.search).has('demo');

async function start() {
  if (!window.harbor && demo) (await import('./mock/mockApi')).installMockApi();
  const root = createRoot(document.getElementById('root')!);
  root.render(<React.StrictMode>{window.harbor ? <App /> : <MissingBridge />}</React.StrictMode>);
}
void start();
