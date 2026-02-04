import { AnthropicAPIConfig, GoogleAIAPI, GoogleAIModelParams } from "../types.js";
export declare function getAnthropicAPI(config?: AnthropicAPIConfig): GoogleAIAPI;
export declare function validateClaudeParams(_params: GoogleAIModelParams): void;
export declare function isModelClaude(modelName: string): boolean;
