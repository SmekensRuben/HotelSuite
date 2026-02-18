export function getSearchTokens(input) {
  return `${input ?? ""}`
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function matchesSearchTokens(value, queryOrTokens) {
  const tokens = Array.isArray(queryOrTokens)
    ? queryOrTokens
    : getSearchTokens(queryOrTokens)

  if (tokens.length === 0) {
    return true
  }

  const normalized = `${value ?? ""}`.toLowerCase()
  if (!normalized) {
    return false
  }

  return tokens.every(token => normalized.includes(token))
}

export function matchesSearchTokensAcross(values, queryOrTokens) {
  const tokens = Array.isArray(queryOrTokens)
    ? queryOrTokens
    : getSearchTokens(queryOrTokens)

  if (tokens.length === 0) {
    return true
  }

  const normalizedValues = (Array.isArray(values) ? values : [values]).map(value =>
    `${value ?? ""}`.toLowerCase()
  )

  if (normalizedValues.every(value => value.length === 0)) {
    return false
  }

  return tokens.every(token => normalizedValues.some(value => value.includes(token)))
}
