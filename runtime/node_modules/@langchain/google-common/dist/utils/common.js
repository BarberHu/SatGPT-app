import { isOpenAITool } from "@langchain/core/language_models/base";
import { isLangChainTool } from "@langchain/core/utils/function_calling";
import { isModelGemini, validateGeminiParams } from "./gemini.js";
import { GeminiToolAttributes, } from "../types.js";
import { jsonSchemaToGeminiParameters, zodToGeminiParameters, } from "./zod_to_gemini_parameters.js";
import { isModelClaude, validateClaudeParams } from "./anthropic.js";
export function copyAIModelParams(params, options) {
    return copyAIModelParamsInto(params, options, {});
}
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
    for (const toolAttribute of GeminiToolAttributes) {
        if (toolAttribute in tool) {
            return true;
        }
    }
    return false;
}
function isGeminiNonFunctionTool(tool) {
    return isGeminiTool(tool) && !("functionDeclaration" in tool);
}
export function convertToGeminiTools(tools) {
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
            else if (isLangChainTool(tool)) {
                const jsonSchema = zodToGeminiParameters(tool.schema);
                geminiTools[functionDeclarationsIndex].functionDeclarations.push({
                    name: tool.name,
                    description: tool.description ?? `A function available to call.`,
                    parameters: jsonSchema,
                });
            }
            else if (isOpenAITool(tool)) {
                geminiTools[functionDeclarationsIndex].functionDeclarations.push({
                    name: tool.function.name,
                    description: tool.function.description ?? `A function available to call.`,
                    parameters: jsonSchemaToGeminiParameters(tool.function.parameters),
                });
            }
            else {
                throw new Error(`Received invalid tool: ${JSON.stringify(tool)}`);
            }
        }
    });
    return geminiTools;
}
export function copyAIModelParamsInto(params, options, target) {
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
export function modelToFamily(modelName) {
    if (!modelName) {
        return null;
    }
    else if (isModelGemini(modelName)) {
        return "gemini";
    }
    else if (isModelClaude(modelName)) {
        return "claude";
    }
    else {
        return null;
    }
}
export function modelToPublisher(modelName) {
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
export function validateModelParams(params) {
    const testParams = params ?? {};
    const model = testParams.model ?? testParams.modelName;
    switch (modelToFamily(model)) {
        case "gemini":
            return validateGeminiParams(testParams);
        case "claude":
            return validateClaudeParams(testParams);
        default:
            throw new Error(`Unable to verify model params: ${JSON.stringify(params)}`);
    }
}
export function copyAndValidateModelParamsInto(params, target) {
    copyAIModelParamsInto(params, undefined, target);
    validateModelParams(target);
    return target;
}
