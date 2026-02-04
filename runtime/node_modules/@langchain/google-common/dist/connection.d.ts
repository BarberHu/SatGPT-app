import { BaseLanguageModelCallOptions } from "@langchain/core/language_models/base";
import { AsyncCaller, AsyncCallerCallOptions } from "@langchain/core/utils/async_caller";
import { BaseRunManager } from "@langchain/core/callbacks/manager";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { GoogleAIBaseLLMInput, GoogleConnectionParams, GooglePlatformType, GoogleResponse, GoogleLLMResponse, GoogleAIModelRequestParams, GoogleRawResponse, GoogleAIAPI, VertexModelFamily, GoogleAIAPIConfig } from "./types.js";
import { GoogleAbstractedClient, GoogleAbstractedClientOps, GoogleAbstractedClientOpsMethod } from "./auth.js";
export declare abstract class GoogleConnection<CallOptions extends AsyncCallerCallOptions, ResponseType extends GoogleResponse> {
    caller: AsyncCaller;
    client: GoogleAbstractedClient;
    streaming: boolean;
    constructor(caller: AsyncCaller, client: GoogleAbstractedClient, streaming?: boolean);
    abstract buildUrl(): Promise<string>;
    abstract buildMethod(): GoogleAbstractedClientOpsMethod;
    _clientInfoHeaders(): Promise<Record<string, string>>;
    _getClientInfo(): Promise<{
        userAgent: string;
        clientLibraryVersion: string;
    }>;
    _moduleName(): Promise<string>;
    additionalHeaders(): Promise<Record<string, string>>;
    _buildOpts(data: unknown | undefined, _options: CallOptions, requestHeaders?: Record<string, string>): Promise<GoogleAbstractedClientOps>;
    _request(data: unknown | undefined, options: CallOptions, requestHeaders?: Record<string, string>): Promise<ResponseType>;
}
export declare abstract class GoogleHostConnection<CallOptions extends AsyncCallerCallOptions, ResponseType extends GoogleResponse, AuthOptions> extends GoogleConnection<CallOptions, ResponseType> implements GoogleConnectionParams<AuthOptions> {
    platformType: GooglePlatformType | undefined;
    _endpoint: string | undefined;
    _location: string | undefined;
    apiVersion: string;
    constructor(fields: GoogleConnectionParams<AuthOptions> | undefined, caller: AsyncCaller, client: GoogleAbstractedClient, streaming?: boolean);
    get platform(): GooglePlatformType;
    get computedPlatformType(): GooglePlatformType;
    get location(): string;
    get computedLocation(): string;
    get endpoint(): string;
    get computedEndpoint(): string;
    buildMethod(): GoogleAbstractedClientOpsMethod;
}
export declare abstract class GoogleRawConnection<CallOptions extends AsyncCallerCallOptions, AuthOptions> extends GoogleHostConnection<CallOptions, GoogleRawResponse, AuthOptions> {
    _buildOpts(data: unknown | undefined, _options: CallOptions, requestHeaders?: Record<string, string>): Promise<GoogleAbstractedClientOps>;
}
export declare abstract class GoogleAIConnection<CallOptions extends AsyncCallerCallOptions, InputType, AuthOptions, ResponseType extends GoogleResponse> extends GoogleHostConnection<CallOptions, ResponseType, AuthOptions> implements GoogleAIBaseLLMInput<AuthOptions> {
    model: string;
    modelName: string;
    client: GoogleAbstractedClient;
    _apiName?: string;
    apiConfig?: GoogleAIAPIConfig;
    constructor(fields: GoogleAIBaseLLMInput<AuthOptions> | undefined, caller: AsyncCaller, client: GoogleAbstractedClient, streaming?: boolean);
    get modelFamily(): VertexModelFamily;
    get modelPublisher(): string;
    get computedAPIName(): string;
    get apiName(): string;
    get api(): GoogleAIAPI;
    get computedPlatformType(): GooglePlatformType;
    get computedLocation(): string;
    abstract buildUrlMethod(): Promise<string>;
    buildUrlGenerativeLanguage(): Promise<string>;
    buildUrlVertex(): Promise<string>;
    buildUrl(): Promise<string>;
    abstract formatData(input: InputType, parameters: GoogleAIModelRequestParams): Promise<unknown>;
    request(input: InputType, parameters: GoogleAIModelRequestParams, options: CallOptions, runManager?: BaseRunManager): Promise<ResponseType>;
}
export declare abstract class AbstractGoogleLLMConnection<MessageType, AuthOptions> extends GoogleAIConnection<BaseLanguageModelCallOptions, MessageType, AuthOptions, GoogleLLMResponse> {
    buildUrlMethodGemini(): Promise<string>;
    buildUrlMethodClaude(): Promise<string>;
    buildUrlMethod(): Promise<string>;
    formatData(input: MessageType, parameters: GoogleAIModelRequestParams): Promise<unknown>;
}
export interface GoogleCustomEventInfo {
    subEvent: string;
    module: string;
}
export declare abstract class GoogleRequestCallbackHandler extends BaseCallbackHandler {
    customEventInfo(eventName: string): GoogleCustomEventInfo;
    abstract handleCustomRequestEvent(eventName: string, eventInfo: GoogleCustomEventInfo, data: any, runId: string, tags?: string[], metadata?: Record<string, any>): any;
    abstract handleCustomResponseEvent(eventName: string, eventInfo: GoogleCustomEventInfo, data: any, runId: string, tags?: string[], metadata?: Record<string, any>): any;
    abstract handleCustomChunkEvent(eventName: string, eventInfo: GoogleCustomEventInfo, data: any, runId: string, tags?: string[], metadata?: Record<string, any>): any;
    handleCustomEvent(eventName: string, data: any, runId: string, tags?: string[], metadata?: Record<string, any>): any;
}
export declare class GoogleRequestLogger extends GoogleRequestCallbackHandler {
    name: string;
    log(eventName: string, data: any, tags?: string[]): undefined;
    handleCustomRequestEvent(eventName: string, _eventInfo: GoogleCustomEventInfo, data: any, _runId: string, tags?: string[], _metadata?: Record<string, any>): any;
    handleCustomResponseEvent(eventName: string, _eventInfo: GoogleCustomEventInfo, data: any, _runId: string, tags?: string[], _metadata?: Record<string, any>): any;
    handleCustomChunkEvent(eventName: string, _eventInfo: GoogleCustomEventInfo, data: any, _runId: string, tags?: string[], _metadata?: Record<string, any>): any;
}
export declare class GoogleRequestRecorder extends GoogleRequestCallbackHandler {
    name: string;
    request: any;
    response: any;
    chunk: any[];
    handleCustomRequestEvent(_eventName: string, _eventInfo: GoogleCustomEventInfo, data: any, _runId: string, _tags?: string[], _metadata?: Record<string, any>): any;
    handleCustomResponseEvent(_eventName: string, _eventInfo: GoogleCustomEventInfo, data: any, _runId: string, _tags?: string[], _metadata?: Record<string, any>): any;
    handleCustomChunkEvent(_eventName: string, _eventInfo: GoogleCustomEventInfo, data: any, _runId: string, _tags?: string[], _metadata?: Record<string, any>): any;
}
