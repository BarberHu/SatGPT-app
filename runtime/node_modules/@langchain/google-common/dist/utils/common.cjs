"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyAndValidateModelParamsInto = exports.validateModelParams = exports.modelToPublisher = exports.modelToFamily = exports.copyAIModelParamsInto = exports.convertToGeminiTools = exports.copyAIModelParams = void 0;
const base_1 = require("@langchain/core/language_models/base");
const function_calling_1 = require("@langchain/core/utils/function_calling");
const gemini_js_1 = require("./gemini.cjs");
const types_js_1 = require("../types.cjs");
const zod_to_gemini_parameters_js_1 = require("./zod_to_gemini_parameters.cjs");
const anthropic_js_1 = require("./anthropic.cjs");
function copyAIModelParams(params, options) {
    return copyAIModelParamsInto(params, options, {});
}
exports.copyAIModelParams = copyAIModelParams;
function processToolChoice(toolChoice, allowedFunctionNames) {
    if (!toolChoice) {
        if (allowedFunctionNames) {
            // Allowed func names is passed, return 'any' so it forces the model to use a tool.
            return {
                tool_choice: "any",
                allowed_function_names: allowedFunctionNames,
            };
        }
        return undefined;
    }
    if (toolChoice === "any" || toolChoice === "auto" || toolChoice === "none") {
        return {
            tool_choice: toolChoice,
            allowed_function_names: allowedFunctionNames,
        };
    }
    if (typeof toolChoice === "string") {
        // String representing the function name.
        // Return any to force the model to predict the specified function call.
        return {
            tool_choice: "any",
            allowed_function_names: [...(allowedFunctionNames ?? []), toolChoice],
        };
    }
    throw new Error("Object inputs for tool_choice not supported.");
}
function isGeminiTool(tool) {
    for (const toolAttribute of types_js_1.GeminiToolAttributes) {
        if (toolAttribute in tool) {
            return true;
        }
    }
    return false;
}
function isGeminiNonFunctionTool(tool) {
    return isGeminiTool(tool) && !("functionDeclaration" in tool);
}
function convertToGeminiTools(tools) {
    const geminiTools = [];
    let functionDeclarationsIndex = -1;
    tools.forEach((tool) => {
        if (isGeminiNonFunctionTool(tool)) {
            geminiTools.push(tool);
        }
        else {
            if (functionDeclarationsIndex === -1) {
                geminiTools.push({
                    functionDeclarations: [],
                });
                functionDeclarationsIndex = geminiTools.length - 1;
            }
            if ("functionDeclarations" in tool &&
                Array.isArray(tool.functionDeclarations)) {
                const funcs = tool.functionDeclarations;
                geminiTools[functionDeclarationsIndex].functionDeclarations.push(...funcs);
            }
            else if ((0, function_calling_1.isLangChainTool)(tool)) {
                const jsonSchema = (0, zod_to_gemini_parameters_js_1.zodToGeminiParameters)(tool.schema);
                geminiTools[functionDeclarationsIndex].functionDeclarations.push({
                    name: tool.name,
                    description: tool.description ?? `A function available to call.`,
                    parameters: jsonSchema,
                });
            }
            else if ((0, base_1.isOpenAITool)(tool)) {
                geminiTools[functionDeclarationsIndex].functionDeclarations.push({
                    name: tool.function.name,
                    description: tool.function.description ?? `A function available to call.`,
                    parameters: (0, zod_to_gemini_parameters_js_1.jsonSchemaToGeminiParameters)(tool.function.parameters),
                });
            }
            else {
                throw new Error(`Received invalid tool: ${JSON.stringify(tool)}`);
            }
        }
    });
    return geminiTools;
}
exports.convertToGeminiTools = convertToGeminiTools;
function copyAIModelParamsInto(params, options, target) {
    const ret = target || {};
    const model = options?.model ?? params?.model ?? target.model;
    ret.modelName =
        model ?? options?.modelName ?? params?.modelName ?? target.modelName;
    ret.model = model;
    ret.temperature =
        options?.temperature ?? params?.temperature ?? target.temperature;
    ret.maxOutputTokens =
        options?.maxOutputTokens ??
            params?.maxOutputTokens ??
            target.maxOutputTokens;
    ret.topP = options?.topP ?? params?.topP ?? target.topP;
    ret.topK = options?.topK ?? params?.topK ?? target.topK;
    ret.presencePenalty =
        options?.presencePenalty ??
            params?.presencePenalty ??
            target.presencePenalty;
    ret.frequencyPenalty =
        options?.frequencyPenalty ??
            params?.frequencyPenalty ??
            target.frequencyPenalty;
    ret.stopSequences =
        options?.stopSequences ?? params?.stopSequences ?? target.stopSequences;
    ret.safetySettings =
        options?.safetySettings ?? params?.safetySettings ?? target.safetySettings;
    ret.logprobs = options?.logprobs ?? params?.logprobs ?? target.logprobs;
    ret.topLogprobs =
        options?.topLogprobs ?? params?.topLogprobs ?? target.topLogprobs;
    ret.convertSystemMessageToHumanContent =
        options?.convertSystemMessageToHumanContent ??
            params?.convertSystemMessageToHumanContent ??
            target?.convertSystemMessageToHumanContent;
    ret.responseMimeType =
        options?.responseMimeType ??
            params?.responseMimeType ??
            target?.responseMimeType;
    ret.streaming = options?.streaming ?? params?.streaming ?? target?.streaming;
    const toolChoice = processToolChoice(options?.tool_choice, options?.allowed_function_names);
    if (toolChoice) {
        ret.tool_choice = toolChoice.tool_choice;
        ret.allowed_function_names = toolChoice.allowed_function_names;
    }
    const tools = options?.tools;
    if (tools) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ret.tools = convertToGeminiTools(tools);
    }
    return ret;
}
exports.copyAIModelParamsInto = copyAIModelParamsInto;
function modelToFamily(modelName) {
    if (!modelName) {
        return null;
    }
    else if ((0, gemini_js_1.isModelGemini)(modelName)) {
        return "gemini";
    }
    else if ((0, anthropic_js_1.isModelClaude)(modelName)) {
        return "claude";
    }
    else {
        return null;
    }
}
exports.modelToFamily = modelToFamily;
function modelToPublisher(modelName) {
    const family = modelToFamily(modelName);
    switch (family) {
        case "gemini":
        case "palm":
            return "google";
        case "claude":
            return "anthropic";
        default:
            return "unknown";
    }
}
exports.modelToPublisher = modelToPublisher;
function validateModelParams(params) {
    const testParams = params ?? {};
    const model = testParams.model ?? testParams.modelName;
    switch (modelToFamily(model)) {
        case "gemini":
            return (0, gemini_js_1.validateGeminiParams)(testParams);
        case "claude":
            return (0, anthropic_js_1.validateClaudeParams)(testParams);
        default:
            throw new Error(`Unable to verify model params: ${JSON.stringify(params)}`);
    }
}
exports.validateModelParams = validateModelParams;
function copyAndValidateModelParamsInto(params, target) {
    copyAIModelParamsInto(params, undefined, target);
    validateModelParams(target);
    return target;
}
exports.copyAndValidateModelParamsInto = copyAndValidateModelParamsInto;
