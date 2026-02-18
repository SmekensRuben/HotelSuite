import React from "react";

export default function Pagination({ currentPage, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    pages.push(
      <button
        key={i}
        type="button"
        onClick={() => onPageChange(i)}
        className={`px-3 py-1 border rounded ${currentPage === i ? 'bg-gray-200 font-semibold' : ''}`}
      >
        {i}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-4">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        className="px-3 py-1 border rounded disabled:text-gray-400 disabled:cursor-not-allowed"
      >
        &lt;
      </button>
      {pages}
      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        className="px-3 py-1 border rounded disabled:text-gray-400 disabled:cursor-not-allowed"
      >
        &gt;
      </button>
    </div>
  );
}

