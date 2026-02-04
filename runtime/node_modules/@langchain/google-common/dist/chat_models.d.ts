import { type BaseMessage } from "@langchain/core/messages";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel, LangSmithParams, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { AIMessageChunk } from "@langchain/core/messages";
import { BaseLanguageModelInput, StructuredOutputMethodOptions } from "@langchain/core/language_models/base";
import type { z } from "zod";
import { Runnable } from "@langchain/core/runnables";
import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { GoogleAIBaseLLMInput, GoogleAIModelParams, GoogleAISafetySetting, GoogleConnectionParams, GooglePlatformType, GoogleAIBaseLanguageModelCallOptions, GoogleAIAPI, GoogleAIAPIParams, GoogleSearchToolSetting } from "./types.js";
import { AbstractGoogleLLMConnection } from "./connection.js";
import { GoogleAbstractedClient } from "./auth.js";
import type { GoogleBaseLLMInput, GoogleAISafetyHandler, GoogleAISafetyParams, GoogleAIToolType, GeminiAPIConfig } from "./types.js";
export declare class ChatConnection<AuthOptions> extends AbstractGoogleLLMConnection<BaseMessage[], AuthOptions> {
    convertSystemMessageToHumanContent: boolean | undefined;
    constructor(fields: GoogleAIBaseLLMInput<AuthOptions> | undefined, caller: AsyncCaller, client: GoogleAbstractedClient, streaming: boolean);
    get useSystemInstruction(): boolean;
    get computeUseSystemInstruction(): boolean;
    computeGoogleSearchToolAdjustmentFromModel(): Exclude<GoogleSearchToolSetting, boolean>;
    computeGoogleSearchToolAdjustment(apiConfig: GeminiAPIConfig): Exclude<GoogleSearchToolSetting, true>;
    buildGeminiAPI(): GoogleAIAPI;
    get api(): GoogleAIAPI;
}
/**
 * Input to chat model class.
 */
export interface ChatGoogleBaseInput<AuthOptions> extends BaseChatModelParams, GoogleConnectionParams<AuthOptions>, GoogleAIModelParams, GoogleAISafetyParams, GoogleAIAPIParams, Pick<GoogleAIBaseLanguageModelCallOptions, "streamUsage"> {
}
/**
 * Integration with a Google chat model.
 */
export declare abstract class ChatGoogleBase<AuthOptions> extends BaseChatModel<GoogleAIBaseLanguageModelCallOptions, AIMessageChunk> implements ChatGoogleBaseInput<AuthOptions> {
    static lc_name(): string;
    get lc_secrets(): {
        [key: string]: string;
    } | undefined;
    lc_serializable: boolean;
    model: string;
    modelName: string;
    temperature: number;
    maxOutputTokens: number;
    topP: number;
    topK: number;
    presencePenalty: number;
    frequencyPenalty: number;
    stopSequences: string[];
    logprobs: boolean;
    topLogprobs: number;
    safetySettings: GoogleAISafetySetting[];
    convertSystemMessageToHumanContent: boolean | undefined;
    safetyHandler: GoogleAISafetyHandler;
    streamUsage: boolean;
    streaming: boolean;
    protected connection: ChatConnection<AuthOptions>;
    protected streamedConnection: ChatConnection<AuthOptions>;
    constructor(fields?: ChatGoogleBaseInput<AuthOptions>);
    getLsParams(options: this["ParsedCallOptions"]): LangSmithParams;
    abstract buildAbstractedClient(fields?: GoogleAIBaseLLMInput<AuthOptions>): GoogleAbstractedClient;
    buildApiKeyClient(apiKey: string): GoogleAbstractedClient;
    buildApiKey(fields?: GoogleAIBaseLLMInput<AuthOptions>): string | undefined;
    buildClient(fields?: GoogleAIBaseLLMInput<AuthOptions>): GoogleAbstractedClient;
    buildConnection(fields: GoogleBaseLLMInput<AuthOptions>, client: GoogleAbstractedClient): void;
    get platform(): GooglePlatformType;
    bindTools(tools: GoogleAIToolType[], kwargs?: Partial<GoogleAIBaseLanguageModelCallOptions>): Runnable<BaseLanguageModelInput, AIMessageChunk, GoogleAIBaseLanguageModelCallOptions>;
    _llmType(): string;
    /**
     * Get the parameters used to invoke the model
     */
    invocationParams(options?: this["ParsedCallOptions"]): import("./types.js").GoogleAIModelRequestParams;
    _generate(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager: CallbackManagerForLLMRun | undefined): Promise<ChatResult>;
    _streamResponseChunks(_messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk>;
    /** @ignore */
    _combineLLMOutput(): never[];
    withStructuredOutput<RunOutput extends Record<string, any> = Record<string, any>>(outputSchema: z.ZodType<RunOutput> | Record<string, any>, config?: StructuredOutputMethodOptions<false>): Runnable<BaseLanguageModelInput, RunOutput>;
    withStructuredOutput<RunOutput extends Record<string, any> = Record<string, any>>(outputSchema: z.ZodType<RunOutput> | Record<string, any>, config?: StructuredOutputMethodOptions<true>): Runnable<BaseLanguageModelInput, {
        raw: BaseMessage;
        parsed: RunOutput;
    }>;
}
