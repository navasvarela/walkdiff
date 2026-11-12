// Reading parsed JSON or TOML, whose shape is unknown until checked.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

export function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === "string" ? found : undefined
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
