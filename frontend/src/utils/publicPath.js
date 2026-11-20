// Vite supplies its build base. Direct Node callers use the default root path.
const base = typeof __SATGPT_BASE_PATH__ === 'string' ? __SATGPT_BASE_PATH__ : '/';
const prefix = base.slice(0, -1);

// Convert internal URL paths at the browser boundary, including paths from saved results.
export function publicPath(url) {
  return typeof url === 'string' && /^\/(?![\\/])/.test(url) ? prefix + url : url;
}
