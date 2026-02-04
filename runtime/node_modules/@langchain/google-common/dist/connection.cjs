"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleRequestRecorder = exports.GoogleRequestLogger = exports.GoogleRequestCallbackHandler = exports.AbstractGoogleLLMConnection = exports.GoogleAIConnection = exports.GoogleRawConnection = exports.GoogleHostConnection = exports.GoogleConnection = void 0;
const env_1 = require("@langchain/core/utils/env");
const base_1 = require("@langchain/core/callbacks/base");
const index_js_1 = require("./utils/index.cjs");
const anthropic_js_1 = require("./utils/anthropic.cjs");
class GoogleConnection {
    constructor(caller, client, streaming) {
        Object.defineProperty(this, "caller", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "client", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "streaming", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.caller = caller;
        this.client = client;
        this.streaming = streaming ?? false;
    }
    async _clientInfoHeaders() {
        const { userAgent, clientLibraryVersion } = await this._getClientInfo();
        return {
            "User-Agent": userAgent,
            "Client-Info": clientLibraryVersion,
        };
    }
    async _getClientInfo() {
        const env = await (0, env_1.getRuntimeEnvironment)();
        const langchain = env?.library ?? "langchain-js";
        // TODO: Add an API for getting the current LangChain version
        const langchainVersion = "0";
        const moduleName = await this._moduleName();
        let clientLibraryVersion = `${langchain}/${langchainVersion}`;
        if (moduleName && moduleName.length) {
            clientLibraryVersion = `${clientLibraryVersion}-${moduleName}`;
        }
        return {
            userAgent: clientLibraryVersion,
            clientLibraryVersion: `${langchainVersion}-${moduleName}`,
        };
    }
    async _moduleName() {
        return this.constructor.name;
    }
    async additionalHeaders() {
        return {};
    }
    async _buildOpts(data, _options, requestHeaders = {}) {
        const url = await this.buildUrl();
        const method = this.buildMethod();
        const infoHeaders = (await this._clientInfoHeaders()) ?? {};
        const additionalHeaders = (await this.additionalHeaders()) ?? {};
        const headers = {
            ...infoHeaders,
            ...additionalHeaders,
            ...requestHeaders,
        };
        const opts = {
            url,
            method,
            headers,
        };
        if (data && method === "POST") {
            opts.data = data;
        }
        if (this.streaming) {
            opts.responseType = "stream";
        }
        else {
            opts.responseType = "json";
        }
        return opts;
    }
    async _request(data, options, requestHeaders = {}) {
        const opts = await this._buildOpts(data, options, requestHeaders);
        const callResponse = await this.caller.callWithOptions({ signal: options?.signal }, async () => this.client.request(opts));
        const response = callResponse; // Done for typecast safety, I guess
        return response;
    }
}
exports.GoogleConnection = GoogleConnection;
class GoogleHostConnection extends GoogleConnection {
    constructor(fields, caller, client, streaming) {
        super(caller, client, streaming);
        // This does not default to a value intentionally.
        // Use the "platform" getter if you need this.
        Object.defineProperty(this, "platformType", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_endpoint", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_location", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "apiVersion", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "v1"
        });
        this.caller = caller;
        this.platformType = fields?.platformType;
        this._endpoint = fields?.endpoint;
        this._location = fields?.location;
        this.apiVersion = fields?.apiVersion ?? this.apiVersion;
        this.client = client;
    }
    get platform() {
        return this.platformType ?? this.computedPlatformType;
    }
    get computedPlatformType() {
        return "gcp";
    }
    get location() {
        return this._location ?? this.computedLocation;
    }
    get computedLocation() {
        return "us-central1";
    }
    get endpoint() {
        return this._endpoint ?? this.computedEndpoint;
    }
    get computedEndpoint() {
        return `${this.location}-aiplatform.googleapis.com`;
    }
    buildMethod() {
        return "POST";
    }
}
exports.GoogleHostConnection = GoogleHostConnection;
class GoogleRawConnection extends GoogleHostConnection {
    async _buildOpts(data, _options, requestHeaders = {}) {
        const opts = await super._buildOpts(data, _options, requestHeaders);
        opts.responseType = "blob";
        return opts;
    }
}
exports.GoogleRawConnection = GoogleRawConnection;
class GoogleAIConnection extends GoogleHostConnection {
    constructor(fields, caller, client, streaming) {
        super(fields, caller, client, streaming);
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
            value: void 0
        });
        Object.defineProperty(this, "client", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_apiName", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "apiConfig", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.client = client;
        this.modelName = fields?.model ?? fields?.modelName ?? this.model;
        this.model = this.modelName;
        this._apiName = fields?.apiName;
        this.apiConfig = {
            safetyHandler: fields?.safetyHandler,
            ...fields?.apiConfig,
        };
    }
    get modelFamily() {
        return (0, index_js_1.modelToFamily)(this.model);
    }
    get modelPublisher() {
        return (0, index_js_1.modelToPublisher)(this.model);
    }
    get computedAPIName() {
        // At least at the moment, model publishers and APIs map the same
        return this.modelPublisher;
    }
    get apiName() {
        return this._apiName ?? this.computedAPIName;
    }
    get api() {
        switch (this.apiName) {
            case "google":
                return (0, index_js_1.getGeminiAPI)(this.apiConfig);
            case "anthropic":
                return (0, anthropic_js_1.getAnthropicAPI)(this.apiConfig);
            default:
                throw new Error(`Unknown API: ${this.apiName}`);
        }
    }
    get computedPlatformType() {
        if (this.client.clientType === "apiKey") {
            return "gai";
        }
        else {
            return "gcp";
        }
    }
    get computedLocation() {
        switch (this.apiName) {
            case "google":
                return super.computedLocation;
            case "anthropic":
                return "us-east5";
            default:
                throw new Error(`Unknown apiName: ${this.apiName}. Can't get location.`);
        }
    }
    async buildUrlGenerativeLanguage() {
        const method = await this.buildUrlMethod();
        const url = `https://generativelanguage.googleapis.com/${this.apiVersion}/models/${this.model}:${method}`;
        return url;
    }
    async buildUrlVertex() {
        const projectId = await this.client.getProjectId();
        const method = await this.buildUrlMethod();
        const publisher = this.modelPublisher;
        const url = `https://${this.endpoint}/${this.apiVersion}/projects/${projectId}/locations/${this.location}/publishers/${publisher}/models/${this.model}:${method}`;
        return url;
    }
    async buildUrl() {
        switch (this.platform) {
            case "gai":
                return this.buildUrlGenerativeLanguage();
            default:
                return this.buildUrlVertex();
        }
    }
    async request(input, parameters, options, runManager) {
        const moduleName = this.constructor.name;
        const streamingParameters = {
            ...parameters,
            streaming: this.streaming,
        };
        const data = await this.formatData(input, streamingParameters);
        await runManager?.handleCustomEvent(`google-request-${moduleName}`, {
            data,
            parameters: streamingParameters,
            options,
            connection: {
                ...this,
                url: await this.buildUrl(),
                urlMethod: await this.buildUrlMethod(),
                modelFamily: this.modelFamily,
                modelPublisher: this.modelPublisher,
                computedPlatformType: this.computedPlatformType,
            },
        });
        const response = await this._request(data, options);
        await runManager?.handleCustomEvent(`google-response-${moduleName}`, {
            response,
        });
        return response;
    }
}
exports.GoogleAIConnection = GoogleAIConnection;
class AbstractGoogleLLMConnection extends GoogleAIConnection {
    async buildUrlMethodGemini() {
        return this.streaming ? "streamGenerateContent" : "generateContent";
    }
    async buildUrlMethodClaude() {
        return this.streaming ? "streamRawPredict" : "rawPredict";
    }
    async buildUrlMethod() {
        switch (this.modelFamily) {
            case "gemini":
                return this.buildUrlMethodGemini();
            case "claude":
                return this.buildUrlMethodClaude();
            default:
                throw new Error(`Unknown model family: ${this.modelFamily}`);
        }
    }
    async formatData(input, parameters) {
        return this.api.formatData(input, parameters);
    }
}
exports.AbstractGoogleLLMConnection = AbstractGoogleLLMConnection;
class GoogleRequestCallbackHandler extends base_1.BaseCallbackHandler {
    customEventInfo(eventName) {
        const names = eventName.split("-");
        return {
            subEvent: names[1],
            module: names[2],
        };
    }
    handleCustomEvent(eventName, data, runId, tags, metadata) {
        if (!eventName) {
            return undefined;
        }
        const eventInfo = this.customEventInfo(eventName);
        switch (eventInfo.subEvent) {
            case "request":
                return this.handleCustomRequestEvent(eventName, eventInfo, data, runId, tags, metadata);
            case "response":
                return this.handleCustomResponseEvent(eventName, eventInfo, data, runId, tags, metadata);
            case "chunk":
                return this.handleCustomChunkEvent(eventName, eventInfo, data, runId, tags, metadata);
            default:
                console.error(`Unexpected eventInfo for ${eventName} ${JSON.stringify(eventInfo, null, 1)}`);
        }
    }
}
exports.GoogleRequestCallbackHandler = GoogleRequestCallbackHandler;
class GoogleRequestLogger extends GoogleRequestCallbackHandler {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "GoogleRequestLogger"
        });
    }
    log(eventName, data, tags) {
        const tagStr = tags ? `[${tags}]` : "[]";
        console.log(`${eventName} ${tagStr} ${JSON.stringify(data, null, 1)}`);
    }
    handleCustomRequestEvent(eventName, _eventInfo, data, _runId, tags, _metadata) {
        this.log(eventName, data, tags);
    }
    handleCustomResponseEvent(eventName, _eventInfo, data, _runId, tags, _metadata) {
        this.log(eventName, data, tags);
    }
    handleCustomChunkEvent(eventName, _eventInfo, data, _runId, tags, _metadata) {
        this.log(eventName, data, tags);
    }
}
exports.GoogleRequestLogger = GoogleRequestLogger;
class GoogleRequestRecorder extends GoogleRequestCallbackHandler {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "GoogleRequestRecorder"
        });
        Object.defineProperty(this, "request", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {}
        });
        Object.defineProperty(this, "response", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {}
        });
        Object.defineProperty(this, "chunk", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
    }
    handleCustomRequestEvent(_eventName, _eventInfo, data, _runId, _tags, _metadata) {
        this.request = data;
    }
    handleCustomResponseEvent(_eventName, _eventInfo, data, _runId, _tags, _metadata) {
        this.response = data;
    }
    handleCustomChunkEvent(_eventName, _eventInfo, data, _runId, _tags, _metadata) {
        this.chunk.push(data);
    }
}
exports.GoogleRequestRecorder = GoogleRequestRecorder;
