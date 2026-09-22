import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const holder = document.getElementById('root');
if (!holder) {
  throw new Error('the root element is missing from index.html');
}
createRoot(holder).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
