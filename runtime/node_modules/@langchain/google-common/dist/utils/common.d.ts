import { GeminiTool, GoogleAIBaseLanguageModelCallOptions, GoogleAIModelParams, GoogleAIModelRequestParams, GoogleAIToolType, VertexModelFamily } from "../types.js";
export declare function copyAIModelParams(params: GoogleAIModelParams | undefined, options: GoogleAIBaseLanguageModelCallOptions | undefined): GoogleAIModelRequestParams;
export declare function convertToGeminiTools(tools: GoogleAIToolType[]): GeminiTool[];
export declare function copyAIModelParamsInto(params: GoogleAIModelParams | undefined, options: GoogleAIBaseLanguageModelCallOptions | undefined, target: GoogleAIModelParams): GoogleAIModelRequestParams;
export declare function modelToFamily(modelName: string | undefined): VertexModelFamily;
export declare function modelToPublisher(modelName: string | undefined): string;
export declare function validateModelParams(params: GoogleAIModelParams | undefined): void;
export declare function copyAndValidateModelParamsInto(params: GoogleAIModelParams | undefined, target: GoogleAIModelParams): GoogleAIModelParams;
