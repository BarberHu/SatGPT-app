/** Download the current map canvas; no screenshot service or credential input. */
export function downloadMapSnapshot(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
    throw new Error('Map capture is unavailable. Please try again.');
  }
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = 'satgpt-map.png';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
