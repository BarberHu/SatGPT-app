import { ensureAuthOptionScopes, JsonStream, SseJsonStream, SseStream, } from "@langchain/google-common";
import { GoogleAuth } from "google-auth-library";
export class NodeAbstractStream {
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
export class NodeJsonStream extends NodeAbstractStream {
    constructor(data) {
        super(new JsonStream(), data);
    }
}
export class NodeSseStream extends NodeAbstractStream {
    constructor(data) {
        super(new SseStream(), data);
    }
}
export class NodeSseJsonStream extends NodeAbstractStream {
    constructor(data) {
        super(new SseJsonStream(), data);
    }
}
export class GAuthClient {
    constructor(fields) {
        Object.defineProperty(this, "gauth", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        const options = ensureAuthOptionScopes(fields?.authOptions, "scopes", fields?.platformType);
        this.gauth = new GoogleAuth(options);
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
