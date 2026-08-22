import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/app.css';

// 将渲染进程未捕获错误写入主进程日志，便于排查
function reportFatal(source, err) {
  try {
    const message = (err && (err.stack || err.message)) || String(err);
    if (window.stab && window.stab.log) window.stab.log('error', `[${source}] ${message}`);
  } catch (e) { /* ignore */ }
  console.error(source, err);
}
window.addEventListener('error', (e) => reportFatal('window.error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportFatal('unhandledrejection', e.reason));

createRoot(document.getElementById('root')).render(<App />);
