import React from 'react';

export function Card({ children, className = '', ...props }) {
  return (
    <div
      className={`bg-white rounded-xl shadow p-6 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
