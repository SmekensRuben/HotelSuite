import React, { useId } from "react";

export default function YesNoToggle({ value = false, onChange, className = "", disabled = false }) {
  const id = useId();
  return (
    <label htmlFor={id} className={`inline-flex items-center ${disabled ? 'cursor-default opacity-60' : 'cursor-pointer'} ${className}`}>
      <input
        id={id}
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={e => !disabled && onChange && onChange(e.target.checked)}
        className="sr-only peer"
      />
      <div
        className={`relative w-12 h-6 rounded-full transition-colors peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-1 ${
          value ? 'bg-green-600' : 'bg-red-600'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            value ? "translate-x-6" : ""
          }`}
        />
      </div>
      <span className="ml-2 text-xs font-semibold">
        {value ? "Ja" : "No"}
      </span>
    </label>
  );
}
