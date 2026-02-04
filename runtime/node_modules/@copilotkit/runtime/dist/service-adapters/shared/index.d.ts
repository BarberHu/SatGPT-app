import { CopilotKitLowLevelError } from '@copilotkit/shared';

/**
 * Converts service adapter errors to structured CopilotKitError format using HTTP status codes.
 * This provides consistent error classification across all service adapters.
 */
declare function convertServiceAdapterError(error: any, adapterName: string): CopilotKitLowLevelError;

export { convertServiceAdapterError };
