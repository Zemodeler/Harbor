import React from 'react';
import { createRoot } from 'react-dom/client';
import { installMockApi } from './mock/mockApi';
import App from './App';

installMockApi();
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
