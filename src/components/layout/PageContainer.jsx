import React from 'react';

export default function PageContainer({ children, className = '', ...props }) {
  return (
    <div className={`max-w-6xl mx-auto py-6 px-4 ${className}`} {...props}>
      {children}
    </div>
  );
}
