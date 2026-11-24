import { Buffer } from 'buffer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Set Buffer before loading Anchor and its transaction dependencies.
globalThis.Buffer ??= Buffer;

void import('./App').then(({ App }) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
