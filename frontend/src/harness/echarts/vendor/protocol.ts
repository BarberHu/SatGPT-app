/** Shared Host/Client contract for routes and validated plugin configuration. */

export const DIST_PREFIX = '/echarts-dist'
export const CONFIG_ROUTE = `${DIST_PREFIX}/config.json`
export const ECHARTS_BUNDLE = 'echarts.min.js'
export const ECHARTS_DIST_FILE = 'echarts/dist/echarts.min.js'

/** Shared by the loader's own timer and the render queue's guard against a stalled env. */
export const LOAD_TIMEOUT_MS = 15_000

const THEMES = ['auto', 'light', 'dark'] as const

export type EChartsTheme = typeof THEMES[number]

export interface EChartsPluginConfig {
  /** 'auto' follows body[data-ds-dark-theme]. */
  theme: EChartsTheme
  /** Chart height in CSS pixels. */
  height: number
  /** Maximum UTF-8 bytes accepted from one fence. */
  maxTextSize: number
  /** Maximum number of recursively visited values in one JSON option. */
  maxOptionNodes: number
}

export const DEFAULT_CONFIG: EChartsPluginConfig = {
  theme: 'auto',
  height: 400,
  maxTextSize: 200_000,
  maxOptionNodes: 100_000,
}

// Derived so that adding a config option means editing the interface and DEFAULT_CONFIG only.
const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

function positiveInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-echarts: invalid ${key} "${String(value)}" (expected a positive integer)`)
  }
  return value
}

type NumericConfigKey = 'height' | 'maxTextSize' | 'maxOptionNodes'

function numeric(input: Record<string, unknown>, key: NumericConfigKey): number {
  return input[key] === undefined ? DEFAULT_CONFIG[key] : positiveInteger(input[key], key)
}

/** Validate the Cordis patch-row config and apply defaults. */
export function validateConfig(raw: Record<string, unknown> | undefined): EChartsPluginConfig {
  const input = raw ?? {}
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-echarts: unknown config key "${key}"`)
  }

  let theme = DEFAULT_CONFIG.theme
  if (input['theme'] !== undefined) {
    const candidate = THEMES.find(known => known === input['theme'])
    if (candidate === undefined) {
      throw new Error(`dsh-echarts: invalid theme "${String(input['theme'])}" (expected ${THEMES.join(', ')})`)
    }
    theme = candidate
  }

  const height = numeric(input, 'height')
  if (height < 200 || height > 1200) {
    throw new Error(`dsh-echarts: invalid height "${height}" (expected an integer from 200 to 1200)`)
  }

  return { theme, height, maxTextSize: numeric(input, 'maxTextSize'), maxOptionNodes: numeric(input, 'maxOptionNodes') }
}
