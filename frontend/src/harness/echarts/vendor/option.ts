import type { EChartsPluginConfig } from './protocol.ts'

export type EChartsOption = Record<string, unknown>

const MAX_DEPTH = 64
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const EXTERNAL_IMAGE = /^(?:image:\/\/|https?:\/\/|\/\/|data:|blob:|javascript:)/i
const EXTERNAL_IMAGE_SYMBOL = /^image:\/\//i
const TITLE_LINK_KEYS = new Set(['link', 'target', 'sublink', 'subtarget'])

export class EChartsOptionError extends Error {
  constructor(message: string) {
    super(`dsh-echarts: ${message}`)
    this.name = 'EChartsOptionError'
  }
}

function pathLabel(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '<root>'
  return path.map((part, index) => typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${part}`).join('')
}

/**
 * Validate and sanitize in one pass.
 *
 * The path is a mutable stack rather than a fresh array per node, and ancestor lookups
 * (`title`, `toolbox`/`feature`) are depth counters rather than repeated `includes` scans —
 * both matter because this runs on the browser's main thread for every fence.
 */
function sanitizeTree(root: unknown, config: EChartsPluginConfig): void {
  const path: Array<string | number> = []
  let nodes = 0
  let titleDepth = 0
  let toolboxDepth = 0
  let featureDepth = 0

  /** Label the offending key; the stack is never unwound because this always throws. */
  const failAt = (key: string, message: string): never => {
    path.push(key)
    throw new EChartsOptionError(`${message} at ${pathLabel(path)}`)
  }

  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new EChartsOptionError(`option exceeds maximum depth ${MAX_DEPTH} at ${pathLabel(path)}`)
    }
    nodes += 1
    if (nodes > config.maxOptionNodes) {
      throw new EChartsOptionError(`option exceeds maxOptionNodes (${config.maxOptionNodes})`)
    }
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new EChartsOptionError(`non-finite number is not allowed at ${pathLabel(path)}`)
    }
    if (current === null || typeof current !== 'object') return

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        path.push(index)
        visit(current[index], depth + 1)
        path.pop()
      }
      return
    }

    const object = current as Record<string, unknown>
    for (const key of Object.keys(object)) {
      const child = object[key]
      if (DANGEROUS_KEYS.has(key)) failAt(key, `unsafe key "${key}"`)
      if (typeof child === 'string') {
        if (key === 'symbol' && EXTERNAL_IMAGE_SYMBOL.test(child)) {
          failAt(key, 'external image symbol is not allowed')
        }
        if (key === 'image' && EXTERNAL_IMAGE.test(child.trim())) {
          failAt(key, 'external image is not allowed')
        }
        if (titleDepth > 0 && TITLE_LINK_KEYS.has(key) && child.trim() !== '') {
          failAt(key, 'title navigation is not allowed')
        }
      }
      if (key === 'dataView' && toolboxDepth > 0 && featureDepth > 0
        && child !== null && typeof child === 'object' && !Array.isArray(child)
        && (child as Record<string, unknown>)['show'] !== false) {
        failAt(key, 'toolbox dataView is not allowed')
      }

      if (key === 'title') titleDepth += 1
      else if (key === 'toolbox') toolboxDepth += 1
      else if (key === 'feature') featureDepth += 1
      path.push(key)
      visit(child, depth + 1)
      path.pop()
      if (key === 'title') titleDepth -= 1
      else if (key === 'toolbox') toolboxDepth -= 1
      else if (key === 'feature') featureDepth -= 1

      // Applied after the subtree is validated so the injected key is not counted or re-scanned.
      if (key === 'tooltip') forceRichText(child)
    }
  }

  visit(root, 0)
}

/** ECharts HTML tooltips would inject assistant-authored markup; richText cannot. */
function forceRichText(value: unknown): void {
  for (const tooltip of Array.isArray(value) ? value : [value]) {
    if (tooltip !== null && typeof tooltip === 'object' && !Array.isArray(tooltip)) {
      ;(tooltip as Record<string, unknown>)['renderMode'] = 'richText'
    }
  }
}

/** Parse, resource-bound, and sanitize an untrusted assistant-produced option. */
export function parseEChartsOption(source: string, config: EChartsPluginConfig): EChartsOption {
  // UTF-8 length is never below the UTF-16 code unit count, so oversized input is rejected
  // before TextEncoder allocates a copy of it — which also bounds that copy to maxTextSize.
  if (source.length > config.maxTextSize) {
    throw new EChartsOptionError(`fence exceeds maxTextSize (${config.maxTextSize} bytes)`)
  }
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > config.maxTextSize) {
    throw new EChartsOptionError(`fence is ${bytes} bytes; maxTextSize is ${config.maxTextSize}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new EChartsOptionError(`invalid JSON: ${detail}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EChartsOptionError('the fence root must be a JSON object')
  }

  sanitizeTree(parsed, config)
  return parsed as EChartsOption
}
