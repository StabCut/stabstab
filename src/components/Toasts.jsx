import React from 'react';
import { useApp } from '../lib/store.jsx';

export default function Toasts() {
  const { state } = useApp();
  if (!state.toasts.length) return null;
  return (
    <div className="toasts">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>
      ))}
    </div>
  );
}
