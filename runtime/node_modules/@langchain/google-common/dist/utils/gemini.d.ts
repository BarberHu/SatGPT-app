import type { GoogleLLMResponse, GoogleAIModelParams, GenerateContentResponseData, GoogleAISafetyHandler, GoogleAIAPI, GeminiAPIConfig } from "../types.js";
export interface FunctionCall {
    name: string;
    arguments: string;
}
export interface ToolCall {
    id: string;
    type: "function";
    function: FunctionCall;
}
export interface FunctionCallRaw {
    name: string;
    arguments: object;
}
export interface ToolCallRaw {
    id: string;
    type: "function";
    function: FunctionCallRaw;
}
export interface DefaultGeminiSafetySettings {
    errorFinish?: string[];
}
export declare class DefaultGeminiSafetyHandler implements GoogleAISafetyHandler {
    errorFinish: string[];
    constructor(settings?: DefaultGeminiSafetySettings);
    handleDataPromptFeedback(response: GoogleLLMResponse, data: GenerateContentResponseData): GenerateContentResponseData;
    handleDataFinishReason(response: GoogleLLMResponse, data: GenerateContentResponseData): GenerateContentResponseData;
    handleData(response: GoogleLLMResponse, data: GenerateContentResponseData): GenerateContentResponseData;
    handle(response: GoogleLLMResponse): GoogleLLMResponse;
}
export interface MessageGeminiSafetySettings extends DefaultGeminiSafetySettings {
    msg?: string;
    forceNewMessage?: boolean;
}
export declare class MessageGeminiSafetyHandler extends DefaultGeminiSafetyHandler {
    msg: string;
    forceNewMessage: boolean;
    constructor(settings?: MessageGeminiSafetySettings);
    setMessage(data: GenerateContentResponseData): GenerateContentResponseData;
    handleData(response: GoogleLLMResponse, data: GenerateContentResponseData): GenerateContentResponseData;
}
export declare function getGeminiAPI(config?: GeminiAPIConfig): GoogleAIAPI;
export declare function validateGeminiParams(params: GoogleAIModelParams): void;
export declare function isModelGemini(modelName: string): boolean;
