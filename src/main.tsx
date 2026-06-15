import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

if (typeof window !== 'undefined' && !(window as any).process) {
  (window as any).process = { env: {} };
}

import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
