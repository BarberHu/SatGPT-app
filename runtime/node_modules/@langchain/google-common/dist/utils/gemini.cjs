"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isModelGemini = exports.validateGeminiParams = exports.getGeminiAPI = exports.MessageGeminiSafetyHandler = exports.DefaultGeminiSafetyHandler = void 0;
const uuid_1 = require("uuid");
const messages_1 = require("@langchain/core/messages");
const outputs_1 = require("@langchain/core/outputs");
const function_calling_1 = require("@langchain/core/utils/function_calling");
const safety_js_1 = require("./safety.cjs");
const types_js_1 = require("../types.cjs");
const zod_to_gemini_parameters_js_1 = require("./zod_to_gemini_parameters.cjs");
class DefaultGeminiSafetyHandler {
    constructor(settings) {
        Object.defineProperty(this, "errorFinish", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["SAFETY", "RECITATION", "OTHER"]
        });
        this.errorFinish = settings?.errorFinish ?? this.errorFinish;
    }
    handleDataPromptFeedback(response, data) {
        // Check to see if our prompt was blocked in the first place
        const promptFeedback = data?.promptFeedback;
        const blockReason = promptFeedback?.blockReason;
        if (blockReason) {
            throw new safety_js_1.GoogleAISafetyError(response, `Prompt blocked: ${blockReason}`);
        }
        return data;
    }
    handleDataFinishReason(response, data) {
        const firstCandidate = data?.candidates?.[0];
        const finishReason = firstCandidate?.finishReason;
        if (this.errorFinish.includes(finishReason)) {
            throw new safety_js_1.GoogleAISafetyError(response, `Finish reason: ${finishReason}`);
        }
        return data;
    }
    handleData(response, data) {
        let ret = data;
        ret = this.handleDataPromptFeedback(response, ret);
        ret = this.handleDataFinishReason(response, ret);
        return ret;
    }
    handle(response) {
        let newdata;
        if ("nextChunk" in response.data) {
            // TODO: This is a stream. How to handle?
            newdata = response.data;
        }
        else if (Array.isArray(response.data)) {
            // If it is an array, try to handle every item in the array
            try {
                newdata = response.data.map((item) => this.handleData(response, item));
            }
            catch (xx) {
                // eslint-disable-next-line no-instanceof/no-instanceof
                if (xx instanceof safety_js_1.GoogleAISafetyError) {
                    throw new safety_js_1.GoogleAISafetyError(response, xx.message);
                }
                else {
                    throw xx;
                }
            }
        }
        else {
            const data = response.data;
            newdata = this.handleData(response, data);
        }
        return {
            ...response,
            data: newdata,
        };
    }
}
exports.DefaultGeminiSafetyHandler = DefaultGeminiSafetyHandler;
class MessageGeminiSafetyHandler extends DefaultGeminiSafetyHandler {
    constructor(settings) {
        super(settings);
        Object.defineProperty(this, "msg", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ""
        });
        Object.defineProperty(this, "forceNewMessage", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        this.msg = settings?.msg ?? this.msg;
        this.forceNewMessage = settings?.forceNewMessage ?? this.forceNewMessage;
    }
    setMessage(data) {
        const ret = data;
        if (this.forceNewMessage ||
            !data?.candidates?.[0]?.content?.parts?.length) {
            ret.candidates = data.candidates ?? [];
            ret.candidates[0] = data.candidates[0] ?? {};
            ret.candidates[0].content = data.candidates[0].content ?? {};
            ret.candidates[0].content = {
                role: "model",
                parts: [{ text: this.msg }],
            };
        }
        return ret;
    }
    handleData(response, data) {
        try {
            return super.handleData(response, data);
        }
        catch (xx) {
            return this.setMessage(data);
        }
    }
}
exports.MessageGeminiSafetyHandler = MessageGeminiSafetyHandler;
const extractMimeType = (str) => {
    if (str.startsWith("data:")) {
        return {
            mimeType: str.split(":")[1].split(";")[0],
            data: str.split(",")[1],
        };
    }
    return null;
};
function getGeminiAPI(config) {
    function messageContentText(content) {
        if (content?.text && content?.text.length > 0) {
            return {
                text: content.text,
            };
        }
        else {
            return null;
        }
    }
    function messageContentImageUrl(content) {
        const url = typeof content.image_url === "string"
            ? content.image_url
            : content.image_url.url;
        if (!url) {
            throw new Error("Missing Image URL");
        }
        const mimeTypeAndData = extractMimeType(url);
        if (mimeTypeAndData) {
            return {
                inlineData: mimeTypeAndData,
            };
        }
        else {
            // FIXME - need some way to get mime type
            return {
                fileData: {
                    mimeType: "image/png",
                    fileUri: url,
                },
            };
        }
    }
    async function blobToFileData(blob) {
        return {
            fileData: {
                fileUri: blob.path,
                mimeType: blob.mimetype,
            },
        };
    }
    async function fileUriContentToBlob(uri) {
        return config?.mediaManager?.getMediaBlob(uri);
    }
    async function messageContentMedia(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content) {
        if ("mimeType" in content && "data" in content) {
            return {
                inlineData: {
                    mimeType: content.mimeType,
                    data: content.data,
                },
            };
        }
        else if ("mimeType" in content && "fileUri" in content) {
            return {
                fileData: {
                    mimeType: content.mimeType,
                    fileUri: content.fileUri,
                },
            };
        }
        else {
            const uri = content.fileUri;
            const blob = await fileUriContentToBlob(uri);
            if (blob) {
                return await blobToFileData(blob);
            }
        }
        throw new Error(`Invalid media content: ${JSON.stringify(content, null, 1)}`);
    }
    async function messageContentComplexToPart(content) {
        switch (content.type) {
            case "text":
                if ("text" in content) {
                    return messageContentText(content);
                }
                break;
            case "image_url":
                if ("image_url" in content) {
                    // Type guard for MessageContentImageUrl
                    return messageContentImageUrl(content);
                }
                break;
            case "media":
                return await messageContentMedia(content);
            default:
                throw new Error(`Unsupported type "${content.type}" received while converting message to message parts: ${content}`);
        }
        throw new Error(`Cannot coerce "${content.type}" message part into a string.`);
    }
    async function messageContentComplexToParts(content) {
        const contents = content.map(messageContentComplexToPart);
        return Promise.all(contents);
    }
    async function messageContentToParts(content) {
        // Convert a string to a text type MessageContent if needed
        const messageContent = typeof content === "string"
            ? [
                {
                    type: "text",
                    text: content,
                },
            ]
            : content;
        // Get all of the parts, even those that don't correctly resolve
        const allParts = await messageContentComplexToParts(messageContent);
        // Remove any invalid parts
        const parts = allParts.reduce((acc, val) => {
            if (val) {
                return [...acc, val];
            }
            else {
                return acc;
            }
        }, []);
        return parts;
    }
    function messageToolCallsToParts(toolCalls) {
        if (!toolCalls || toolCalls.length === 0) {
            return [];
        }
        return toolCalls.map((tool) => {
            let args = {};
            if (tool?.function?.arguments) {
                const argStr = tool.function.arguments;
                args = JSON.parse(argStr);
            }
            return {
                functionCall: {
                    name: tool.function.name,
                    args,
                },
            };
        });
    }
    function messageKwargsToParts(kwargs) {
        const ret = [];
        if (kwargs?.tool_calls) {
            ret.push(...messageToolCallsToParts(kwargs.tool_calls));
        }
        return ret;
    }
    async function roleMessageToContent(role, message) {
        const contentParts = await messageContentToParts(message.content);
        let toolParts;
        if ((0, messages_1.isAIMessage)(message) && !!message.tool_calls?.length) {
            toolParts = message.tool_calls.map((toolCall) => ({
                functionCall: {
                    name: toolCall.name,
                    args: toolCall.args,
                },
            }));
        }
        else {
            toolParts = messageKwargsToParts(message.additional_kwargs);
        }
        const parts = [...contentParts, ...toolParts];
        return [
            {
                role,
                parts,
            },
        ];
    }
    async function systemMessageToContent(message) {
        return config?.useSystemInstruction
            ? roleMessageToContent("system", message)
            : [
                ...(await roleMessageToContent("user", message)),
                ...(await roleMessageToContent("model", new messages_1.AIMessage("Ok"))),
            ];
    }
    function toolMessageToContent(message, prevMessage) {
        const contentStr = typeof message.content === "string"
            ? message.content
            : message.content.reduce((acc, content) => {
                if (content.type === "text") {
                    return acc + content.text;
                }
                else {
                    return acc;
                }
            }, "");
        // Hacky :(
        const responseName = ((0, messages_1.isAIMessage)(prevMessage) && !!prevMessage.tool_calls?.length
            ? prevMessage.tool_calls[0].name
            : prevMessage.name) ?? message.tool_call_id;
        try {
            const content = JSON.parse(contentStr);
            return [
                {
                    role: "function",
                    parts: [
                        {
                            functionResponse: {
                                name: responseName,
                                response: { content },
                            },
                        },
                    ],
                },
            ];
        }
        catch (_) {
            return [
                {
                    role: "function",
                    parts: [
                        {
                            functionResponse: {
                                name: responseName,
                                response: { content: contentStr },
                            },
                        },
                    ],
                },
            ];
        }
    }
    async function baseMessageToContent(message, prevMessage) {
        const type = message._getType();
        switch (type) {
            case "system":
                return systemMessageToContent(message);
            case "human":
                return roleMessageToContent("user", message);
            case "ai":
                return roleMessageToContent("model", message);
            case "tool":
                if (!prevMessage) {
                    throw new Error("Tool messages cannot be the first message passed to the model.");
                }
                return toolMessageToContent(message, prevMessage);
            default:
                console.log(`Unsupported message type: ${type}`);
                return [];
        }
    }
    function textPartToMessageContent(part) {
        return {
            type: "text",
            text: part.text,
        };
    }
    function inlineDataPartToMessageContent(part) {
        return {
            type: "image_url",
            image_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        };
    }
    function fileDataPartToMessageContent(part) {
        return {
            type: "image_url",
            image_url: part.fileData.fileUri,
        };
    }
    function partsToMessageContent(parts) {
        return parts
            .map((part) => {
            if (part === undefined || part === null) {
                return null;
            }
            else if ("text" in part) {
                return textPartToMessageContent(part);
            }
            else if ("inlineData" in part) {
                return inlineDataPartToMessageContent(part);
            }
            else if ("fileData" in part) {
                return fileDataPartToMessageContent(part);
            }
            else {
                return null;
            }
        })
            .reduce((acc, content) => {
            if (content) {
                acc.push(content);
            }
            return acc;
        }, []);
    }
    function toolRawToTool(raw) {
        return {
            id: raw.id,
            type: raw.type,
            function: {
                name: raw.function.name,
                arguments: JSON.stringify(raw.function.arguments),
            },
        };
    }
    function functionCallPartToToolRaw(part) {
        return {
            id: (0, uuid_1.v4)().replace(/-/g, ""),
            type: "function",
            function: {
                name: part.functionCall.name,
                arguments: part.functionCall.args ?? {},
            },
        };
    }
    function partsToToolsRaw(parts) {
        return parts
            .map((part) => {
            if (part === undefined || part === null) {
                return null;
            }
            else if ("functionCall" in part) {
                return functionCallPartToToolRaw(part);
            }
            else {
                return null;
            }
        })
            .reduce((acc, content) => {
            if (content) {
                acc.push(content);
            }
            return acc;
        }, []);
    }
    function toolsRawToTools(raws) {
        return raws.map((raw) => toolRawToTool(raw));
    }
    function responseToGenerateContentResponseData(response) {
        if ("nextChunk" in response.data) {
            throw new Error("Cannot convert Stream to GenerateContentResponseData");
        }
        else if (Array.isArray(response.data)) {
            // Collapse the array of response data as if it was a single one
            return response.data.reduce((acc, val) => {
                // Add all the parts
                // FIXME: Handle other candidates?
                const valParts = val?.candidates?.[0]?.content?.parts ?? [];
                acc.candidates[0].content.parts.push(...valParts);
                // FIXME: Merge promptFeedback and safety settings
                acc.promptFeedback = val.promptFeedback;
                return acc;
            });
        }
        else {
            return response.data;
        }
    }
    function responseToParts(response) {
        const responseData = responseToGenerateContentResponseData(response);
        const parts = responseData?.candidates?.[0]?.content?.parts ?? [];
        return parts;
    }
    function partToText(part) {
        return "text" in part ? part.text : "";
    }
    function responseToString(response) {
        const parts = responseToParts(response);
        const ret = parts.reduce((acc, part) => {
            const val = partToText(part);
            return acc + val;
        }, "");
        return ret;
    }
    function safeResponseTo(response, responseTo) {
        const safetyHandler = config?.safetyHandler ?? new DefaultGeminiSafetyHandler();
        try {
            const safeResponse = safetyHandler.handle(response);
            return responseTo(safeResponse);
        }
        catch (xx) {
            // eslint-disable-next-line no-instanceof/no-instanceof
            if (xx instanceof safety_js_1.GoogleAISafetyError) {
                const ret = responseTo(xx.response);
                xx.reply = ret;
            }
            throw xx;
        }
    }
    function safeResponseToString(response) {
        return safeResponseTo(response, responseToString);
    }
    function logprobResultToLogprob(result) {
        const token = result?.token;
        const logprob = result?.logProbability;
        const encoder = new TextEncoder();
        const bytes = Array.from(encoder.encode(token));
        return {
            token,
            logprob,
            bytes,
        };
    }
    function candidateToLogprobs(candidate) {
        const logprobs = candidate?.logprobsResult;
        const chosenTokens = logprobs?.chosenCandidates ?? [];
        const topTokens = logprobs?.topCandidates ?? [];
        const content = [];
        for (let co = 0; co < chosenTokens.length; co += 1) {
            const chosen = chosenTokens[co];
            const top = topTokens[co]?.candidates ?? [];
            const logprob = logprobResultToLogprob(chosen);
            logprob.top_logprobs = top.map((l) => logprobResultToLogprob(l));
            content.push(logprob);
        }
        return {
            content,
        };
    }
    function responseToGenerationInfo(response) {
        if (!Array.isArray(response.data)) {
            return {};
        }
        const data = response.data[0];
        return {
            usage_metadata: {
                prompt_token_count: data.usageMetadata?.promptTokenCount,
                candidates_token_count: data.usageMetadata?.candidatesTokenCount,
                total_token_count: data.usageMetadata?.totalTokenCount,
            },
            safety_ratings: data.candidates[0]?.safetyRatings?.map((rating) => ({
                category: rating.category,
                probability: rating.probability,
                probability_score: rating.probabilityScore,
                severity: rating.severity,
                severity_score: rating.severityScore,
            })),
            citation_metadata: data.candidates[0]?.citationMetadata,
            grounding_metadata: data.candidates[0]?.groundingMetadata,
            finish_reason: data.candidates[0]?.finishReason,
            avgLogprobs: data.candidates[0]?.avgLogprobs,
            logprobs: candidateToLogprobs(data.candidates[0]),
        };
    }
    function responseToChatGeneration(response) {
        return new outputs_1.ChatGenerationChunk({
            text: responseToString(response),
            message: partToMessageChunk(responseToParts(response)[0]),
            generationInfo: responseToGenerationInfo(response),
        });
    }
    function safeResponseToChatGeneration(response) {
        return safeResponseTo(response, responseToChatGeneration);
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
    function partToMessageChunk(part) {
        const fields = partsToBaseMessageChunkFields([part]);
        if (typeof fields.content === "string") {
            return new messages_1.AIMessageChunk(fields);
        }
        else if (fields.content.every((item) => item.type === "text")) {
            const newContent = fields.content
                .map((item) => ("text" in item ? item.text : ""))
                .join("");
            return new messages_1.AIMessageChunk({
                ...fields,
                content: newContent,
            });
        }
        return new messages_1.AIMessageChunk(fields);
    }
    function partToChatGeneration(part) {
        const message = partToMessageChunk(part);
        const text = partToText(part);
        return new outputs_1.ChatGenerationChunk({
            text,
            message,
        });
    }
    function groundingSupportByPart(groundingSupports) {
        const ret = [];
        if (!groundingSupports || groundingSupports.length === 0) {
            return [];
        }
        groundingSupports?.forEach((groundingSupport) => {
            const segment = groundingSupport?.segment;
            const partIndex = segment?.partIndex ?? 0;
            if (ret[partIndex]) {
                ret[partIndex].push(groundingSupport);
            }
            else {
                ret[partIndex] = [groundingSupport];
            }
        });
        return ret;
    }
    function responseToGroundedChatGenerations(response) {
        const parts = responseToParts(response);
        if (parts.length === 0) {
            return [];
        }
        // Citation and grounding information connected to each part / ChatGeneration
        // to make sure they are available in downstream filters.
        const candidate = response?.data
            ?.candidates?.[0];
        const groundingMetadata = candidate?.groundingMetadata;
        const citationMetadata = candidate?.citationMetadata;
        const groundingParts = groundingSupportByPart(groundingMetadata?.groundingSupports);
        const ret = parts.map((part, index) => {
            const gen = partToChatGeneration(part);
            if (!gen.generationInfo) {
                gen.generationInfo = {};
            }
            if (groundingMetadata) {
                gen.generationInfo.groundingMetadata = groundingMetadata;
                const groundingPart = groundingParts[index];
                if (groundingPart) {
                    gen.generationInfo.groundingSupport = groundingPart;
                }
            }
            if (citationMetadata) {
                gen.generationInfo.citationMetadata = citationMetadata;
            }
            return gen;
        });
        return ret;
    }
    function responseToChatGenerations(response) {
        let ret = responseToGroundedChatGenerations(response);
        if (ret.length === 0) {
            return [];
        }
        if (ret.every((item) => typeof item.message.content === "string")) {
            const combinedContent = ret.map((item) => item.message.content).join("");
            const combinedText = ret.map((item) => item.text).join("");
            const toolCallChunks = ret[ret.length - 1]?.message.additional_kwargs?.tool_calls?.map((toolCall, i) => ({
                name: toolCall.function.name,
                args: toolCall.function.arguments,
                id: toolCall.id,
                index: i,
                type: "tool_call_chunk",
            }));
            let usageMetadata;
            if ("usageMetadata" in response.data) {
                usageMetadata = {
                    input_tokens: response.data.usageMetadata.promptTokenCount,
                    output_tokens: response.data.usageMetadata
                        .candidatesTokenCount,
                    total_tokens: response.data.usageMetadata.totalTokenCount,
                };
            }
            ret = [
                new outputs_1.ChatGenerationChunk({
                    message: new messages_1.AIMessageChunk({
                        content: combinedContent,
                        additional_kwargs: ret[ret.length - 1]?.message.additional_kwargs,
                        tool_call_chunks: toolCallChunks,
                        usage_metadata: usageMetadata,
                    }),
                    text: combinedText,
                    generationInfo: ret[ret.length - 1].generationInfo,
                }),
            ];
        }
        // Add logprobs information to the message
        const candidate = response?.data
            ?.candidates?.[0];
        const avgLogprobs = candidate?.avgLogprobs;
        const logprobs = candidateToLogprobs(candidate);
        if (logprobs) {
            ret[0].message.response_metadata = {
                ...ret[0].message.response_metadata,
                logprobs,
                avgLogprobs,
            };
        }
        return ret;
    }
    function responseToBaseMessageFields(response) {
        const parts = responseToParts(response);
        return partsToBaseMessageChunkFields(parts);
    }
    function partsToBaseMessageChunkFields(parts) {
        const fields = {
            content: partsToMessageContent(parts),
            tool_call_chunks: [],
            tool_calls: [],
            invalid_tool_calls: [],
        };
        const rawTools = partsToToolsRaw(parts);
        if (rawTools.length > 0) {
            const tools = toolsRawToTools(rawTools);
            for (const tool of tools) {
                fields.tool_call_chunks?.push({
                    name: tool.function.name,
                    args: tool.function.arguments,
                    id: tool.id,
                    type: "tool_call_chunk",
                });
                try {
                    fields.tool_calls?.push({
                        name: tool.function.name,
                        args: JSON.parse(tool.function.arguments),
                        id: tool.id,
                    });
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }
                catch (e) {
                    fields.invalid_tool_calls?.push({
                        name: tool.function.name,
                        args: tool.function.arguments,
                        id: tool.id,
                        error: e.message,
                        type: "invalid_tool_call",
                    });
                }
            }
            fields.additional_kwargs = {
                tool_calls: tools,
            };
        }
        return fields;
    }
    function responseToBaseMessage(response) {
        const fields = responseToBaseMessageFields(response);
        return new messages_1.AIMessage(fields);
    }
    function safeResponseToBaseMessage(response) {
        return safeResponseTo(response, responseToBaseMessage);
    }
    function responseToChatResult(response) {
        const generations = responseToChatGenerations(response);
        return {
            generations,
            llmOutput: responseToGenerationInfo(response),
        };
    }
    function safeResponseToChatResult(response) {
        return safeResponseTo(response, responseToChatResult);
    }
    function inputType(input) {
        if (typeof input === "string") {
            return "MessageContent";
        }
        else {
            const firstItem = input[0];
            if (Object.hasOwn(firstItem, "content")) {
                return "BaseMessageArray";
            }
            else {
                return "MessageContent";
            }
        }
    }
    async function formatMessageContents(input, _parameters) {
        const parts = await messageContentToParts(input);
        const contents = [
            {
                role: "user",
                parts,
            },
        ];
        return contents;
    }
    async function formatBaseMessageContents(input, _parameters) {
        const inputPromises = input.map((msg, i) => baseMessageToContent(msg, input[i - 1]));
        const inputs = await Promise.all(inputPromises);
        return inputs.reduce((acc, cur) => {
            // Filter out the system content
            if (cur.every((content) => content.role === "system")) {
                return acc;
            }
            // Combine adjacent function messages
            if (cur[0]?.role === "function" &&
                acc.length > 0 &&
                acc[acc.length - 1].role === "function") {
                acc[acc.length - 1].parts = [
                    ...acc[acc.length - 1].parts,
                    ...cur[0].parts,
                ];
            }
            else {
                acc.push(...cur);
            }
            return acc;
        }, []);
    }
    async function formatContents(input, parameters) {
        const it = inputType(input);
        switch (it) {
            case "MessageContent":
                return formatMessageContents(input, parameters);
            case "BaseMessageArray":
                return formatBaseMessageContents(input, parameters);
            default:
                throw new Error(`Unknown input type "${it}": ${input}`);
        }
    }
    function formatGenerationConfig(parameters) {
        const ret = {
            temperature: parameters.temperature,
            topK: parameters.topK,
            topP: parameters.topP,
            presencePenalty: parameters.presencePenalty,
            frequencyPenalty: parameters.frequencyPenalty,
            maxOutputTokens: parameters.maxOutputTokens,
            stopSequences: parameters.stopSequences,
            responseMimeType: parameters.responseMimeType,
        };
        // Add the logprobs if explicitly set
        if (typeof parameters.logprobs !== "undefined") {
            ret.responseLogprobs = parameters.logprobs;
            if (parameters.logprobs &&
                typeof parameters.topLogprobs !== "undefined") {
                ret.logprobs = parameters.topLogprobs;
            }
        }
        return ret;
    }
    function formatSafetySettings(parameters) {
        return parameters.safetySettings ?? [];
    }
    async function formatBaseMessageSystemInstruction(input) {
        let ret = {};
        for (let index = 0; index < input.length; index += 1) {
            const message = input[index];
            if (message._getType() === "system") {
                // For system types, we only want it if it is the first message,
                // if it appears anywhere else, it should be an error.
                if (index === 0) {
                    // eslint-disable-next-line prefer-destructuring
                    ret = (await baseMessageToContent(message, undefined))[0];
                }
                else {
                    throw new Error("System messages are only permitted as the first passed message.");
                }
            }
        }
        return ret;
    }
    async function formatSystemInstruction(input) {
        if (!config?.useSystemInstruction) {
            return {};
        }
        const it = inputType(input);
        switch (it) {
            case "BaseMessageArray":
                return formatBaseMessageSystemInstruction(input);
            default:
                return {};
        }
    }
    function structuredToolToFunctionDeclaration(tool) {
        const jsonSchema = (0, zod_to_gemini_parameters_js_1.zodToGeminiParameters)(tool.schema);
        return {
            name: tool.name,
            description: tool.description ?? `A function available to call.`,
            parameters: jsonSchema,
        };
    }
    function searchToolName(tool) {
        for (const name of types_js_1.GeminiSearchToolAttributes) {
            if (name in tool) {
                return name;
            }
        }
        return undefined;
    }
    function cleanGeminiTool(tool) {
        const orig = searchToolName(tool);
        const adj = config?.googleSearchToolAdjustment;
        if (orig && adj && adj !== orig) {
            return {
                [adj]: {},
            };
        }
        else {
            return tool;
        }
    }
    function formatTools(parameters) {
        const tools = parameters?.tools;
        if (!tools || tools.length === 0) {
            return [];
        }
        // Group all LangChain tools into a single functionDeclarations array.
        // Gemini Tools may be normalized to different tool names
        const langChainTools = [];
        const otherTools = [];
        tools.forEach((tool) => {
            if ((0, function_calling_1.isLangChainTool)(tool)) {
                langChainTools.push(tool);
            }
            else {
                otherTools.push(cleanGeminiTool(tool));
            }
        });
        const result = [...otherTools];
        if (langChainTools.length > 0) {
            result.push({
                functionDeclarations: langChainTools.map(structuredToolToFunctionDeclaration),
            });
        }
        return result;
    }
    function formatToolConfig(parameters) {
        if (!parameters.tool_choice || typeof parameters.tool_choice !== "string") {
            return undefined;
        }
        if (["auto", "any", "none"].includes(parameters.tool_choice)) {
            return {
                functionCallingConfig: {
                    mode: parameters.tool_choice,
                    allowedFunctionNames: parameters.allowed_function_names,
                },
            };
        }
        // force tool choice to be a single function name in case of structured output
        return {
            functionCallingConfig: {
                mode: "any",
                allowedFunctionNames: [parameters.tool_choice],
            },
        };
    }
    async function formatData(input, parameters) {
        const typedInput = input;
        const contents = await formatContents(typedInput, parameters);
        const generationConfig = formatGenerationConfig(parameters);
        const tools = formatTools(parameters);
        const toolConfig = formatToolConfig(parameters);
        const safetySettings = formatSafetySettings(parameters);
        const systemInstruction = await formatSystemInstruction(typedInput);
        const ret = {
            contents,
            generationConfig,
        };
        if (tools && tools.length) {
            ret.tools = tools;
        }
        if (toolConfig) {
            ret.toolConfig = toolConfig;
        }
        if (safetySettings && safetySettings.length) {
            ret.safetySettings = safetySettings;
        }
        if (systemInstruction?.role &&
            systemInstruction?.parts &&
            systemInstruction?.parts?.length) {
            ret.systemInstruction = systemInstruction;
        }
        return ret;
    }
    return {
        messageContentToParts,
        baseMessageToContent,
        responseToString: safeResponseToString,
        responseToChatGeneration: safeResponseToChatGeneration,
        chunkToString,
        responseToBaseMessage: safeResponseToBaseMessage,
        responseToChatResult: safeResponseToChatResult,
        formatData,
    };
}
exports.getGeminiAPI = getGeminiAPI;
function validateGeminiParams(params) {
    if (params.maxOutputTokens && params.maxOutputTokens < 0) {
        throw new Error("`maxOutputTokens` must be a positive integer");
    }
    if (params.temperature &&
        (params.temperature < 0 || params.temperature > 2)) {
        throw new Error("`temperature` must be in the range of [0.0,2.0]");
    }
    if (params.topP && (params.topP < 0 || params.topP > 1)) {
        throw new Error("`topP` must be in the range of [0.0,1.0]");
    }
    if (params.topK && params.topK < 0) {
        throw new Error("`topK` must be a positive integer");
    }
}
exports.validateGeminiParams = validateGeminiParams;
function isModelGemini(modelName) {
    return modelName.toLowerCase().startsWith("gemini");
}
exports.isModelGemini = isModelGemini;
