"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatGoogleBase = exports.ChatConnection = void 0;
const env_1 = require("@langchain/core/utils/env");
const chat_models_1 = require("@langchain/core/language_models/chat_models");
const outputs_1 = require("@langchain/core/outputs");
const messages_1 = require("@langchain/core/messages");
const runnables_1 = require("@langchain/core/runnables");
const openai_tools_1 = require("@langchain/core/output_parsers/openai_tools");
const stream_1 = require("@langchain/core/utils/stream");
const common_js_1 = require("./utils/common.cjs");
const connection_js_1 = require("./connection.cjs");
const gemini_js_1 = require("./utils/gemini.cjs");
const auth_js_1 = require("./auth.cjs");
const failed_handler_js_1 = require("./utils/failed_handler.cjs");
const zod_to_gemini_parameters_js_1 = require("./utils/zod_to_gemini_parameters.cjs");
class ChatConnection extends connection_js_1.AbstractGoogleLLMConnection {
    constructor(fields, caller, client, streaming) {
        super(fields, caller, client, streaming);
        Object.defineProperty(this, "convertSystemMessageToHumanContent", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.convertSystemMessageToHumanContent =
            fields?.convertSystemMessageToHumanContent;
    }
    get useSystemInstruction() {
        return typeof this.convertSystemMessageToHumanContent === "boolean"
            ? !this.convertSystemMessageToHumanContent
            : this.computeUseSystemInstruction;
    }
    get computeUseSystemInstruction() {
        // This works on models from April 2024 and later
        //   Vertex AI: gemini-1.5-pro and gemini-1.0-002 and later
        //   AI Studio: gemini-1.5-pro-latest
        if (this.modelFamily === "palm") {
            return false;
        }
        else if (this.modelName === "gemini-1.0-pro-001") {
            return false;
        }
        else if (this.modelName.startsWith("gemini-pro-vision")) {
            return false;
        }
        else if (this.modelName.startsWith("gemini-1.0-pro-vision")) {
            return false;
        }
        else if (this.modelName === "gemini-pro" && this.platform === "gai") {
            // on AI Studio gemini-pro is still pointing at gemini-1.0-pro-001
            return false;
        }
        return true;
    }
    computeGoogleSearchToolAdjustmentFromModel() {
        if (this.modelName.startsWith("gemini-1.0")) {
            return "googleSearchRetrieval";
        }
        else if (this.modelName.startsWith("gemini-1.5")) {
            return "googleSearchRetrieval";
        }
        else {
            return "googleSearch";
        }
    }
    computeGoogleSearchToolAdjustment(apiConfig) {
        const adj = apiConfig.googleSearchToolAdjustment;
        if (adj === undefined || adj === true) {
            return this.computeGoogleSearchToolAdjustmentFromModel();
        }
        else {
            return adj;
        }
    }
    buildGeminiAPI() {
        const apiConfig = this.apiConfig ?? {};
        const googleSearchToolAdjustment = this.computeGoogleSearchToolAdjustment(apiConfig);
        const geminiConfig = {
            useSystemInstruction: this.useSystemInstruction,
            googleSearchToolAdjustment,
            ...apiConfig,
        };
        return (0, gemini_js_1.getGeminiAPI)(geminiConfig);
    }
    get api() {
        switch (this.apiName) {
            case "google":
                return this.buildGeminiAPI();
            default:
                return super.api;
        }
    }
}
exports.ChatConnection = ChatConnection;
/**
 * Integration with a Google chat model.
 */
class ChatGoogleBase extends chat_models_1.BaseChatModel {
    // Used for tracing, replace with the same name as your class
    static lc_name() {
        return "ChatGoogle";
    }
    get lc_secrets() {
        return {
            authOptions: "GOOGLE_AUTH_OPTIONS",
        };
    }
    constructor(fields) {
        super((0, failed_handler_js_1.ensureParams)(fields));
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        // Set based on modelName
        Object.defineProperty(this, "model", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "modelName", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "gemini-pro"
        });
        Object.defineProperty(this, "temperature", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0.7
        });
        Object.defineProperty(this, "maxOutputTokens", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 1024
        });
        Object.defineProperty(this, "topP", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0.8
        });
        Object.defineProperty(this, "topK", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 40
        });
        Object.defineProperty(this, "presencePenalty", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "frequencyPenalty", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "stopSequences", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "logprobs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "topLogprobs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "safetySettings", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        // May intentionally be undefined, meaning to compute this.
        Object.defineProperty(this, "convertSystemMessageToHumanContent", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "safetyHandler", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "streamUsage", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "streaming", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "streamedConnection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        (0, common_js_1.copyAndValidateModelParamsInto)(fields, this);
        this.safetyHandler =
            fields?.safetyHandler ?? new gemini_js_1.DefaultGeminiSafetyHandler();
        this.streamUsage = fields?.streamUsage ?? this.streamUsage;
        const client = this.buildClient(fields);
        this.buildConnection(fields ?? {}, client);
    }
    getLsParams(options) {
        const params = this.invocationParams(options);
        return {
            ls_provider: "google_vertexai",
            ls_model_name: this.model,
            ls_model_type: "chat",
            ls_temperature: params.temperature ?? undefined,
            ls_max_tokens: params.maxOutputTokens ?? undefined,
            ls_stop: options.stop,
        };
    }
    buildApiKeyClient(apiKey) {
        return new auth_js_1.ApiKeyGoogleAuth(apiKey);
    }
    buildApiKey(fields) {
        if (fields?.platformType !== "gcp") {
            return fields?.apiKey ?? (0, env_1.getEnvironmentVariable)("GOOGLE_API_KEY");
        }
        else {
            // GCP doesn't support API Keys
            return undefined;
        }
    }
    buildClient(fields) {
        const apiKey = this.buildApiKey(fields);
        if (apiKey) {
            return this.buildApiKeyClient(apiKey);
        }
        else {
            return this.buildAbstractedClient(fields);
        }
    }
    buildConnection(fields, client) {
        this.connection = new ChatConnection({ ...fields, ...this }, this.caller, client, false);
        this.streamedConnection = new ChatConnection({ ...fields, ...this }, this.caller, client, true);
    }
    get platform() {
        return this.connection.platform;
    }
    bindTools(tools, kwargs) {
        return this.bind({ tools: (0, common_js_1.convertToGeminiTools)(tools), ...kwargs });
    }
    // Replace
    _llmType() {
        return "chat_integration";
    }
    /**
     * Get the parameters used to invoke the model
     */
    invocationParams(options) {
        return (0, common_js_1.copyAIModelParams)(this, options);
    }
    async _generate(messages, options, runManager) {
        const parameters = this.invocationParams(options);
        if (this.streaming) {
            const stream = this._streamResponseChunks(messages, options, runManager);
            let finalChunk = null;
            for await (const chunk of stream) {
                finalChunk = !finalChunk ? chunk : (0, stream_1.concat)(finalChunk, chunk);
            }
            if (!finalChunk) {
                throw new Error("No chunks were returned from the stream.");
            }
            return {
                generations: [finalChunk],
            };
        }
        const response = await this.connection.request(messages, parameters, options, runManager);
        const ret = this.connection.api.responseToChatResult(response);
        const chunk = ret?.generations?.[0];
        if (chunk) {
            await runManager?.handleLLMNewToken(chunk.text || "");
        }
        return ret;
    }
    async *_streamResponseChunks(_messages, options, runManager) {
        // Make the call as a streaming request
        const parameters = this.invocationParams(options);
        const response = await this.streamedConnection.request(_messages, parameters, options, runManager);
        // Get the streaming parser of the response
        const stream = response.data;
        let usageMetadata;
        // Loop until the end of the stream
        // During the loop, yield each time we get a chunk from the streaming parser
        // that is either available or added to the queue
        while (!stream.streamDone) {
            const output = await stream.nextChunk();
            await runManager?.handleCustomEvent(`google-chunk-${this.constructor.name}`, {
                output,
            });
            if (output &&
                output.usageMetadata &&
                this.streamUsage !== false &&
                options.streamUsage !== false) {
                usageMetadata = {
                    input_tokens: output.usageMetadata.promptTokenCount,
                    output_tokens: output.usageMetadata.candidatesTokenCount,
                    total_tokens: output.usageMetadata.totalTokenCount,
                };
            }
            const chunk = output !== null
                ? this.connection.api.responseToChatGeneration({ data: output })
                : new outputs_1.ChatGenerationChunk({
                    text: "",
                    generationInfo: { finishReason: "stop" },
                    message: new messages_1.AIMessageChunk({
                        content: "",
                        usage_metadata: usageMetadata,
                    }),
                });
            if (chunk) {
                yield chunk;
                await runManager?.handleLLMNewToken(chunk.text ?? "", undefined, undefined, undefined, undefined, { chunk });
            }
        }
    }
    /** @ignore */
    _combineLLMOutput() {
        return [];
    }
    withStructuredOutput(outputSchema, config) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const schema = outputSchema;
        const name = config?.name;
        const method = config?.method;
        const includeRaw = config?.includeRaw;
        if (method === "jsonMode") {
            throw new Error(`Google only supports "functionCalling" as a method.`);
        }
        let functionName = name ?? "extract";
        let outputParser;
        let tools;
        if (isZodSchema(schema)) {
            const jsonSchema = (0, zod_to_gemini_parameters_js_1.zodToGeminiParameters)(schema);
            tools = [
                {
                    functionDeclarations: [
                        {
                            name: functionName,
                            description: jsonSchema.description ?? "A function available to call.",
                            parameters: jsonSchema,
                        },
                    ],
                },
            ];
            outputParser = new openai_tools_1.JsonOutputKeyToolsParser({
                returnSingle: true,
                keyName: functionName,
                zodSchema: schema,
            });
        }
        else {
            let geminiFunctionDefinition;
            if (typeof schema.name === "string" &&
                typeof schema.parameters === "object" &&
                schema.parameters != null) {
                geminiFunctionDefinition = schema;
                functionName = schema.name;
            }
            else {
                geminiFunctionDefinition = {
                    name: functionName,
                    description: schema.description ?? "",
                    parameters: schema,
                };
            }
            tools = [
                {
                    functionDeclarations: [geminiFunctionDefinition],
                },
            ];
            outputParser = new openai_tools_1.JsonOutputKeyToolsParser({
                returnSingle: true,
                keyName: functionName,
            });
        }
        const llm = this.bind({
            tools,
            tool_choice: functionName,
        });
        if (!includeRaw) {
            return llm.pipe(outputParser).withConfig({
                runName: "ChatGoogleStructuredOutput",
            });
        }
        const parserAssign = runnables_1.RunnablePassthrough.assign({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parsed: (input, config) => outputParser.invoke(input.raw, config),
        });
        const parserNone = runnables_1.RunnablePassthrough.assign({
            parsed: () => null,
        });
        const parsedWithFallback = parserAssign.withFallbacks({
            fallbacks: [parserNone],
        });
        return runnables_1.RunnableSequence.from([
            {
                raw: llm,
            },
            parsedWithFallback,
        ]).withConfig({
            runName: "StructuredOutputRunnable",
        });
    }
}
exports.ChatGoogleBase = ChatGoogleBase;
function isZodSchema(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
input) {
    // Check for a characteristic method of Zod schemas
    return typeof input?.parse === "function";
}
