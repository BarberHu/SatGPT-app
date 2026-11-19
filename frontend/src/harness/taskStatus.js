export const isActiveTask = status => ['queued', 'starting', 'running', 'cancelling', 'cleaning'].includes(status);
export const canStopTask = status => ['queued', 'starting', 'running'].includes(status);
export const isTerminalTask = status => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);

