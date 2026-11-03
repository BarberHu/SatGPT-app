# SatGPT chart integration (trial)

Agent Markdown renders lowercase `echarts` fenced blocks containing strict JSON.
Charts wait for the response to finish, load ECharts locally near the viewport,
resize with the chat panel, and dispose when the message unmounts. JSON remains
available for copying; invalid options fall back to source with an error.
The current application uses a light theme, which the charts follow.

The original DSH Web plugin is not registered in the SDK profile: SatGPT owns
its React UI. Its option validator and configuration contract are vendored
unchanged from https://github.com/sheny-bio/dsh-echarts at commit
`b16bbb4ac2cafcc72cc97c83e05be88d9bd7e564`. See `vendor/LICENSE` and
`vendor/NOTICE`. The React lifecycle and export controls are SatGPT adapters.
ECharts itself is an npm dependency, bundled by Vite without a CDN.

Review locally at `/?review=echarts` while running the Vite development server.
This route uses the actual Agent message renderer with clearly marked sample
data, and does not write chat history or call GEE. It is excluded from production.

Integration baseline: Git tag `snapshot/pre-echarts-20261103` (`411028d`).
