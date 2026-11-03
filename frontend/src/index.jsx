if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('review') === 'echarts') {
  import('./harness/echarts/reviewEntry');
} else {
  import('./appEntry');
}
