/// <reference types="node" resolution-mode="require"/>
import { Readable } from "stream";
import { AbstractStream, GoogleAbstractedClient, GoogleAbstractedClientOps, GoogleConnectionParams } from "@langchain/google-common";
import { GoogleAuth, GoogleAuthOptions } from "google-auth-library";
export declare class NodeAbstractStream implements AbstractStream {
    private baseStream;
    constructor(baseStream: AbstractStream, data: Readable);
    appendBuffer(data: string): void;
    closeBuffer(): void;
    nextChunk(): Promise<any>;
    get streamDone(): boolean;
}
export declare class NodeJsonStream extends NodeAbstractStream {
    constructor(data: Readable);
}
export declare class NodeSseStream extends NodeAbstractStream {
    constructor(data: Readable);
}
export declare class NodeSseJsonStream extends NodeAbstractStream {
    constructor(data: Readable);
}
export declare class GAuthClient implements GoogleAbstractedClient {
    gauth: GoogleAuth;
    constructor(fields?: GoogleConnectionParams<GoogleAuthOptions>);
    get clientType(): string;
    getProjectId(): Promise<string>;
    request(opts: GoogleAbstractedClientOps): Promise<unknown>;
}
