"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isModelClaude = exports.validateClaudeParams = exports.getAnthropicAPI = void 0;
const outputs_1 = require("@langchain/core/outputs");
const messages_1 = require("@langchain/core/messages");
function getAnthropicAPI(config) {
    function partToString(part) {
        return "text" in part ? part.text : "";
    }
    function messageToString(message) {
        const content = message?.content ?? [];
        const ret = content.reduce((acc, part) => {
            const str = partToString(part);
            return acc + str;
        }, "");
        return ret;
    }
    function responseToString(response) {
        const data = response.data;
        switch (data?.type) {
            case "message":
                return messageToString(data);
            default:
                throw Error(`Unknown type: ${data?.type}`);
        }
    }
    /**
     * Normalize the AIMessageChunk.
     * If the fields are just a string - use that as content.
     * If the content is an array of just text fields, turn them into a string.
     * @param fields
     */
    function newAIMessageChunk(fields) {
        if (typeof fields === "string") {
            return new messages_1.AIMessageChunk(fields);
        }
        const ret = {
            ...fields,
        };
        if (Array.isArray(fields?.content)) {
            let str = "";
            fields.content.forEach((val) => {
                if (str !== undefined && val.type === "text") {
                    str = `${str}${val.text}`;
                }
                else {
                    str = undefined;
                }
            });
            if (str) {
                ret.content = str;
            }
        }
        return new messages_1.AIMessageChunk(ret);
    }
    function textContentToMessageFields(textContent) {
        return {
            content: [textContent],
        };
    }
    function toolUseContentToMessageFields(toolUseContent) {
        const tool = {
            id: toolUseContent.id,
            name: toolUseContent.name,
            type: "tool_call",
            args: toolUseContent.input,
        };
        return {
            content: [],
            tool_calls: [tool],
        };
    }
    function anthropicContentToMessageFields(anthropicContent) {
        const type = anthropicContent?.type;
        switch (type) {
            case "text":
                return textContentToMessageFields(anthropicContent);
            case "tool_use":
                return toolUseContentToMessageFields(anthropicContent);
            default:
                return undefined;
        }
    }
    function contentToMessage(anthropicContent) {
        const complexContent = [];
        const toolCalls = [];
        anthropicContent.forEach((ac) => {
            const messageFields = anthropicContentToMessageFields(ac);
            if (messageFields?.content) {
                complexContent.push(...messageFields.content);
            }
            if (messageFields?.tool_calls) {
                toolCalls.push(...messageFields.tool_calls);
            }
        });
        const ret = {
            content: complexContent,
            tool_calls: toolCalls,
        };
        return newAIMessageChunk(ret);
    }
    function messageToGenerationInfo(message) {
        const usage = message?.usage;
        const usageMetadata = {
            input_tokens: usage?.input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
            total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        };
        return {
            usage_metadata: usageMetadata,
            finish_reason: message.stop_reason,
        };
    }
    function messageToChatGeneration(responseMessage) {
        const content = responseMessage?.content ?? [];
        const text = messageToString(responseMessage);
        const message = contentToMessage(content);
        const generationInfo = messageToGenerationInfo(responseMessage);
        return new outputs_1.ChatGenerationChunk({
            text,
            message,
            generationInfo,
        });
    }
    function messageStartToChatGeneration(event) {
        const responseMessage = event.message;
        return messageToChatGeneration(responseMessage);
    }
    function messageDeltaToChatGeneration(event) {
        const responseMessage = event.delta;
        return messageToChatGeneration(responseMessage);
    }
    function contentBlockStartTextToChatGeneration(event) {
        const content = event.content_block;
        const message = contentToMessage([content]);
        if (!message) {
            return null;
        }
        const text = "text" in content ? content.text : "";
        return new outputs_1.ChatGenerationChunk({
            message,
            text,
        });
    }
    function contentBlockStartToolUseToChatGeneration(event) {
        const contentBlock = event.content_block;
        const text = "";
        const toolChunk = {
            type: "tool_call_chunk",
            index: event.index,
            name: contentBlock.name,
            id: contentBlock.id,
        };
        if (typeof contentBlock.input === "object" &&
            Object.keys(contentBlock.input).length > 0) {
            toolChunk.args = JSON.stringify(contentBlock.input);
        }
        const toolChunks = [toolChunk];
        const content = [
            {
                index: event.index,
                ...contentBlock,
            },
        ];
        const messageFields = {
            content,
            tool_call_chunks: toolChunks,
        };
        const message = newAIMessageChunk(messageFields);
        return new outputs_1.ChatGenerationChunk({
            message,
            text,
        });
    }
    function contentBlockStartToChatGeneration(event) {
        switch (event.content_block.type) {
            case "text":
                return contentBlockStartTextToChatGeneration(event);
            case "tool_use":
                return contentBlockStartToolUseToChatGeneration(event);
            default:
                console.warn(`Unexpected start content_block type: ${JSON.stringify(event)}`);
                return null;
        }
    }
    function contentBlockDeltaTextToChatGeneration(event) {
        const delta = event.delta;
        const text = delta?.text;
        const message = newAIMessageChunk(text);
        return new outputs_1.ChatGenerationChunk({
            message,
            text,
        });
    }
    function contentBlockDeltaInputJsonDeltaToChatGeneration(event) {
        const delta = event.delta;
        const text = "";
        const toolChunks = [
            {
                index: event.index,
                args: delta.partial_json,
            },
        ];
        const content = [
            {
                index: event.index,
                ...delta,
            },
        ];
        const messageFields = {
            content,
            tool_call_chunks: toolChunks,
        };
        const message = newAIMessageChunk(messageFields);
        return new outputs_1.ChatGenerationChunk({
            message,
            text,
        });
    }
    function contentBlockDeltaToChatGeneration(event) {
        switch (event.delta.type) {
            case "text_delta":
                return contentBlockDeltaTextToChatGeneration(event);
            case "input_json_delta":
                return contentBlockDeltaInputJsonDeltaToChatGeneration(event);
            default:
                console.warn(`Unexpected delta content_block type: ${JSON.stringify(event)}`);
                return null;
        }
    }
    function responseToChatGeneration(response) {
        const data = response.data;
        switch (data.type) {
            case "message":
                return messageToChatGeneration(data);
            case "message_start":
                return messageStartToChatGeneration(data);
            case "message_delta":
                return messageDeltaToChatGeneration(data);
            case "content_block_start":
                return contentBlockStartToChatGeneration(data);
            case "content_block_delta":
                return contentBlockDeltaToChatGeneration(data);
            case "ping":
            case "message_stop":
            case "content_block_stop":
                // These are ignorable
                return null;
            case "error":
                throw new Error(`Error while streaming results: ${JSON.stringify(data)}`);
            default:
                // We don't know what type this is, but Anthropic may have added
                // new ones without telling us. Don't error, but don't use them.
                console.warn("Unknown data for responseToChatGeneration", data);
                // throw new Error(`Unknown response type: ${data.type}`);
                return null;
        }
    }
    function chunkToString(chunk) {
        if (chunk === null) {
            return "";
        }
        else if (typeof chunk.content === "string") {
            return chunk.content;
        }
        else if (chunk.content.length === 0) {
            return "";
        }
        else if (chunk.content[0].type === "text") {
            return chunk.content[0].text;
        }
        else {
            throw new Error(`Unexpected chunk: ${chunk}`);
        }
    }
    function responseToBaseMessage(response) {
        const data = response.data;
        const content = data?.content ?? [];
        return contentToMessage(content);
    }
    function responseToChatResult(response) {
        const message = response.data;
        const generations = [];
        const gen = responseToChatGeneration(response);
        if (gen) {
            generations.push(gen);
        }
        const llmOutput = messageToGenerationInfo(message);
        return {
            generations,
            llmOutput,
        };
    }
    function formatAnthropicVersion() {
        return config?.version ?? "vertex-2023-10-16";
    }
    function textContentToAnthropicContent(content) {
        return content;
    }
    function extractMimeType(str) {
        if (str.startsWith("data:")) {
            return {
                media_type: str.split(":")[1].split(";")[0],
                data: str.split(",")[1],
            };
        }
        return null;
    }
    function imageContentToAnthropicContent(content) {
        const dataUrl = content.image_url;
        const url = typeof dataUrl === "string" ? dataUrl : dataUrl?.url;
        const urlInfo = extractMimeType(url);
        if (!urlInfo) {
            return undefined;
        }
        return {
            type: "image",
            source: {
                type: "base64",
                ...urlInfo,
            },
        };
    }
    function contentComplexToAnthropicContent(content) {
        const type = content?.type;
        switch (type) {
            case "text":
                return textContentToAnthropicContent(content);
            case "image_url":
                return imageContentToAnthropicContent(content);
            default:
                console.warn(`Unexpected content type: ${type}`);
                return undefined;
        }
    }
    function contentToAnthropicContent(content) {
        const ret = [];
        const ca = typeof content === "string" ? [{ type: "text", text: content }] : content;
        ca.forEach((complex) => {
            const ac = contentComplexToAnthropicContent(complex);
            if (ac) {
                ret.push(ac);
            }
        });
        return ret;
    }
    function baseRoleToAnthropicMessage(base, role) {
        const content = contentToAnthropicContent(base.content);
        return {
            role,
            content,
        };
    }
    function toolMessageToAnthropicMessage(base) {
        const role = "user";
        const toolUseId = base.tool_call_id;
        const toolContent = contentToAnthropicContent(base.content);
        const content = [
            {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: toolContent,
            },
        ];
        return {
            role,
            content,
        };
    }
    function baseToAnthropicMessage(base) {
        const type = base._getType();
        switch (type) {
            case "human":
                return baseRoleToAnthropicMessage(base, "user");
            case "ai":
                return baseRoleToAnthropicMessage(base, "assistant");
            case "tool":
                return toolMessageToAnthropicMessage(base);
            default:
                return undefined;
        }
    }
    function formatMessages(input) {
        const ret = [];
        input.forEach((baseMessage) => {
            const anthropicMessage = baseToAnthropicMessage(baseMessage);
            if (anthropicMessage) {
                ret.push(anthropicMessage);
            }
        });
        return ret;
    }
    function formatSettings(parameters) {
        const ret = {
            stream: parameters?.streaming ?? false,
            max_tokens: parameters?.maxOutputTokens ?? 8192,
        };
        if (parameters.topP) {
            ret.top_p = parameters.topP;
        }
        if (parameters.topK) {
            ret.top_k = parameters.topK;
        }
        if (parameters.temperature) {
            ret.temperature = parameters.temperature;
        }
        if (parameters.stopSequences) {
            ret.stop_sequences = parameters.stopSequences;
        }
        return ret;
    }
    function contentComplexArrayToText(contentArray) {
        let ret = "";
        contentArray.forEach((content) => {
            const contentType = content?.type;
            if (contentType === "text") {
                const textContent = content;
                ret = `${ret}\n${textContent.text}`;
            }
        });
        return ret;
    }
    function formatSystem(input) {
        let ret = "";
        input.forEach((message) => {
            if (message._getType() === "system") {
                const content = message?.content;
                const contentString = typeof content === "string"
                    ? content
                    : contentComplexArrayToText(content);
                ret = `${ret}\n${contentString}`;
            }
        });
        return ret;
    }
    function formatGeminiTool(tool) {
        if (Object.hasOwn(tool, "functionDeclarations")) {
            const funcs = tool?.functionDeclarations ?? [];
            return funcs.map((func) => {
                const inputSchema = func.parameters;
                return {
                    // type: "tool",  // This may only be valid for models 20241022+
                    name: func.name,
                    description: func.description,
                    input_schema: inputSchema,
                };
            });
        }
        else {
            console.warn(`Unable to format GeminiTool: ${JSON.stringify(tool, null, 1)}`);
            return [];
        }
    }
    function formatTool(tool) {
        if (Object.hasOwn(tool, "name")) {
            return [tool];
        }
        else {
            return formatGeminiTool(tool);
        }
    }
    function formatTools(parameters) {
        const tools = parameters?.tools ?? [];
        const ret = [];
        tools.forEach((tool) => {
            const anthropicTools = formatTool(tool);
            anthropicTools.forEach((anthropicTool) => {
                if (anthropicTool) {
                    ret.push(anthropicTool);
                }
            });
        });
        return ret;
    }
    function formatToolChoice(parameters) {
        const choice = parameters?.tool_choice;
        if (!choice) {
            return undefined;
        }
        else if (typeof choice === "object") {
            return choice;
        }
        else {
            switch (choice) {
                case "any":
                case "auto":
                    return {
                        type: choice,
                    };
                case "none":
                    return undefined;
                default:
                    return {
                        type: "tool",
                        name: choice,
                    };
            }
        }
    }
    async function formatData(input, parameters) {
        const typedInput = input;
        const anthropicVersion = formatAnthropicVersion();
        const messages = formatMessages(typedInput);
        const settings = formatSettings(parameters);
        const system = formatSystem(typedInput);
        const tools = formatTools(parameters);
        const toolChoice = formatToolChoice(parameters);
        const ret = {
            anthropic_version: anthropicVersion,
            messages,
            ...settings,
        };
        if (tools && tools.length && parameters?.tool_choice !== "none") {
            ret.tools = tools;
        }
        if (toolChoice) {
            ret.tool_choice = toolChoice;
        }
        if (system?.length) {
            ret.system = system;
        }
        return ret;
    }
    return {
        responseToString,
        responseToChatGeneration,
        chunkToString,
        responseToBaseMessage,
        responseToChatResult,
        formatData,
    };
}
exports.getAnthropicAPI = getAnthropicAPI;
function validateClaudeParams(_params) {
    // FIXME - validate the parameters
}
exports.validateClaudeParams = validateClaudeParams;
function isModelClaude(modelName) {
    return modelName.toLowerCase().startsWith("claude");
}
exports.isModelClaude = isModelClaude;
