// src/components/ui/combobox.jsx
import * as React from "react"
import { getSearchTokens, matchesSearchTokens } from "utils/search"

export function Combobox({
  value,
  onChange,
  options,
  displayValue,
  getOptionValue,
  placeholder,
  disabled,
  required,
  id,
  name,
  className,
}) {
  const [query, setQuery] = React.useState("")
  const [isOpen, setIsOpen] = React.useState(false)

  const filteredOptions = React.useMemo(() => {
    const tokens = getSearchTokens(query)

    if (tokens.length === 0) {
      return options
    }

    return options.filter(option =>
      matchesSearchTokens(displayValue(option), tokens)
    )
  }, [displayValue, options, query])

  const inputClassName = className || "w-full border rounded p-2"

  const closeList = () => {
    setIsOpen(false)
    setQuery("")
  }

  const handleOptionSelect = option => {
    onChange(option)
    closeList()
  }

  const handleBlur = () => {
    setTimeout(() => {
      setIsOpen(false)
    }, 100)

    if (query !== "") {
      const match = filteredOptions[0]
      if (match) {
        handleOptionSelect(match)
        return
      }
    }

    setQuery("")
  }

  return (
    <div className="relative">
      <input
        type="text"
        id={id}
        name={name}
        className={inputClassName}
        placeholder={placeholder}
        value={query !== "" ? query : value ? displayValue(value) : ""}
        onChange={event => {
          setQuery(event.target.value)
          setIsOpen(true)
        }}
        onFocus={() => {
          setIsOpen(true)
          setQuery("")
        }}
        onBlur={handleBlur}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault()
            const match = filteredOptions[0]
            if (match) {
              handleOptionSelect(match)
            }
          } else if (event.key === "Escape") {
            closeList()
          }
        }}
        disabled={disabled}
        required={required}
        autoComplete="off"
      />
      {isOpen && filteredOptions.length > 0 && (
        <ul className="absolute z-10 w-full bg-white border mt-1 rounded shadow max-h-48 overflow-y-auto">
          {filteredOptions.map(option => (
            <li
              key={getOptionValue(option)}
              className="px-4 py-2 hover:bg-gray-100 cursor-pointer"
              onMouseDown={event => {
                event.preventDefault()
              }}
              onClick={() => {
                handleOptionSelect(option)
              }}
            >
              {displayValue(option)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
