"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GAuthClient = exports.NodeSseJsonStream = exports.NodeSseStream = exports.NodeJsonStream = exports.NodeAbstractStream = void 0;
const google_common_1 = require("@langchain/google-common");
const google_auth_library_1 = require("google-auth-library");
class NodeAbstractStream {
    constructor(baseStream, data) {
        Object.defineProperty(this, "baseStream", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.baseStream = baseStream;
        const decoder = new TextDecoder("utf-8");
        data.on("data", (data) => {
            const text = decoder.decode(data, { stream: true });
            this.appendBuffer(text);
        });
        data.on("end", () => {
            const rest = decoder.decode();
            this.appendBuffer(rest);
            this.closeBuffer();
        });
    }
    appendBuffer(data) {
        return this.baseStream.appendBuffer(data);
    }
    closeBuffer() {
        return this.baseStream.closeBuffer();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nextChunk() {
        return this.baseStream.nextChunk();
    }
    get streamDone() {
        return this.baseStream.streamDone;
    }
}
exports.NodeAbstractStream = NodeAbstractStream;
class NodeJsonStream extends NodeAbstractStream {
    constructor(data) {
        super(new google_common_1.JsonStream(), data);
    }
}
exports.NodeJsonStream = NodeJsonStream;
class NodeSseStream extends NodeAbstractStream {
    constructor(data) {
        super(new google_common_1.SseStream(), data);
    }
}
exports.NodeSseStream = NodeSseStream;
class NodeSseJsonStream extends NodeAbstractStream {
    constructor(data) {
        super(new google_common_1.SseJsonStream(), data);
    }
}
exports.NodeSseJsonStream = NodeSseJsonStream;
class GAuthClient {
    constructor(fields) {
        Object.defineProperty(this, "gauth", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        const options = (0, google_common_1.ensureAuthOptionScopes)(fields?.authOptions, "scopes", fields?.platformType);
        this.gauth = new google_auth_library_1.GoogleAuth(options);
    }
    get clientType() {
        return "gauth";
    }
    async getProjectId() {
        return this.gauth.getProjectId();
    }
    async request(opts) {
        const ret = await this.gauth.request(opts);
        const [contentType] = ret?.headers?.["content-type"]?.split(/;/) ?? [""];
        if (opts.responseType !== "stream") {
            return ret;
        }
        else if (contentType === "text/event-stream") {
            return {
                ...ret,
                data: new NodeSseJsonStream(ret.data),
            };
        }
        else {
            return {
                ...ret,
                data: new NodeJsonStream(ret.data),
            };
        }
    }
}
exports.GAuthClient = GAuthClient;
