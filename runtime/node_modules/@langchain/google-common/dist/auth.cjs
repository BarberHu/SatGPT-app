"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAuthOptionScopes = exports.aiPlatformScope = exports.ApiKeyGoogleAuth = exports.GoogleAbstractedFetchClient = void 0;
const stream_js_1 = require("./utils/stream.cjs");
class GoogleAbstractedFetchClient {
    async _buildData(res, opts) {
        switch (opts.responseType) {
            case "json":
                return res.json();
            case "stream":
                return new stream_js_1.ReadableJsonStream(res.body);
            default:
                return res.blob();
        }
    }
    async _request(url, opts, additionalHeaders) {
        if (url == null)
            throw new Error("Missing URL");
        const fetchOptions = {
            method: opts.method,
            headers: {
                "Content-Type": "application/json",
                ...(opts.headers ?? {}),
                ...(additionalHeaders ?? {}),
            },
        };
        if (opts.data !== undefined) {
            if (typeof opts.data === "string") {
                fetchOptions.body = opts.data;
            }
            else {
                fetchOptions.body = JSON.stringify(opts.data);
            }
        }
        const res = await fetch(url, fetchOptions);
        if (!res.ok) {
            const resText = await res.text();
            const error = new Error(`Google request failed with status code ${res.status}: ${resText}`);
            /* eslint-disable @typescript-eslint/no-explicit-any */
            error.response = res;
            error.details = {
                url,
                opts,
                fetchOptions,
                result: res,
            };
            /* eslint-enable @typescript-eslint/no-explicit-any */
            throw error;
        }
        const data = await this._buildData(res, opts);
        return {
            data,
            config: {},
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
            request: { responseURL: res.url },
        };
    }
}
exports.GoogleAbstractedFetchClient = GoogleAbstractedFetchClient;
class ApiKeyGoogleAuth extends GoogleAbstractedFetchClient {
    constructor(apiKey) {
        super();
        Object.defineProperty(this, "apiKey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.apiKey = apiKey;
    }
    get clientType() {
        return "apiKey";
    }
    getProjectId() {
        throw new Error("APIs that require a project ID cannot use an API key");
        // Perhaps we could implement this if needed:
        // https://cloud.google.com/docs/authentication/api-keys#get-info
    }
    request(opts) {
        const authHeader = {
            "X-Goog-Api-Key": this.apiKey,
        };
        return this._request(opts.url, opts, authHeader);
    }
}
exports.ApiKeyGoogleAuth = ApiKeyGoogleAuth;
function aiPlatformScope(platform) {
    switch (platform) {
        case "gai":
            return ["https://www.googleapis.com/auth/generative-language"];
        default:
            return ["https://www.googleapis.com/auth/cloud-platform"];
    }
}
exports.aiPlatformScope = aiPlatformScope;
function ensureAuthOptionScopes(authOption, scopeProperty, scopesOrPlatform) {
    // If the property is already set, return it
    if (authOption && Object.hasOwn(authOption, scopeProperty)) {
        return authOption;
    }
    // Otherwise add it
    const scopes = Array.isArray(scopesOrPlatform)
        ? scopesOrPlatform
        : aiPlatformScope(scopesOrPlatform ?? "gcp");
    return {
        [scopeProperty]: scopes,
        ...(authOption ?? {}),
    };
}
exports.ensureAuthOptionScopes = ensureAuthOptionScopes;
