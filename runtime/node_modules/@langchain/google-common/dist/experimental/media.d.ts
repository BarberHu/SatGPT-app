import { AsyncCaller, AsyncCallerCallOptions, AsyncCallerParams } from "@langchain/core/utils/async_caller";
import { MediaBlob, BlobStore, BlobStoreOptions } from "./utils/media_core.js";
import { GoogleConnectionParams, GoogleRawResponse, GoogleResponse } from "../types.js";
import { GoogleHostConnection, GoogleRawConnection } from "../connection.js";
import { GoogleAbstractedClient, GoogleAbstractedClientOpsMethod } from "../auth.js";
export interface GoogleUploadConnectionParams<AuthOptions> extends GoogleConnectionParams<AuthOptions> {
}
export declare abstract class GoogleMultipartUploadConnection<CallOptions extends AsyncCallerCallOptions, ResponseType extends GoogleResponse, AuthOptions> extends GoogleHostConnection<CallOptions, ResponseType, AuthOptions> {
    constructor(fields: GoogleConnectionParams<AuthOptions> | undefined, caller: AsyncCaller, client: GoogleAbstractedClient);
    _body(separator: string, data: MediaBlob, metadata: Record<string, unknown>): Promise<string>;
    request(data: MediaBlob, metadata: Record<string, unknown>, options: CallOptions): Promise<ResponseType>;
}
export declare abstract class GoogleDownloadConnection<CallOptions extends AsyncCallerCallOptions, ResponseType extends GoogleResponse, AuthOptions> extends GoogleHostConnection<CallOptions, ResponseType, AuthOptions> {
    request(options: CallOptions): Promise<ResponseType>;
}
export declare abstract class GoogleDownloadRawConnection<CallOptions extends AsyncCallerCallOptions, AuthOptions> extends GoogleRawConnection<CallOptions, AuthOptions> {
    buildMethod(): GoogleAbstractedClientOpsMethod;
    request(options: CallOptions): Promise<GoogleRawResponse>;
}
export interface BlobStoreGoogleParams<AuthOptions> extends GoogleConnectionParams<AuthOptions>, AsyncCallerParams, BlobStoreOptions {
}
export declare abstract class BlobStoreGoogle<ResponseType extends GoogleResponse, AuthOptions> extends BlobStore {
    caller: AsyncCaller;
    client: GoogleAbstractedClient;
    constructor(fields?: BlobStoreGoogleParams<AuthOptions>);
    abstract buildClient(fields?: BlobStoreGoogleParams<AuthOptions>): GoogleAbstractedClient;
    abstract buildSetMetadata([key, blob]: [string, MediaBlob]): Record<string, unknown>;
    abstract buildSetConnection([key, blob]: [
        string,
        MediaBlob
    ]): GoogleMultipartUploadConnection<AsyncCallerCallOptions, ResponseType, AuthOptions>;
    _set(keyValuePair: [string, MediaBlob]): Promise<ResponseType>;
    mset(keyValuePairs: [string, MediaBlob][]): Promise<void>;
    abstract buildGetMetadataConnection(key: string): GoogleDownloadConnection<AsyncCallerCallOptions, ResponseType, AuthOptions>;
    _getMetadata(key: string): Promise<Record<string, unknown>>;
    abstract buildGetDataConnection(key: string): GoogleDownloadRawConnection<AsyncCallerCallOptions, AuthOptions>;
    _getData(key: string): Promise<Blob>;
    _getMimetypeFromMetadata(metadata: Record<string, unknown>): string;
    _get(key: string): Promise<MediaBlob | undefined>;
    mget(keys: string[]): Promise<(MediaBlob | undefined)[]>;
    abstract buildDeleteConnection(key: string): GoogleDownloadConnection<AsyncCallerCallOptions, GoogleResponse, AuthOptions>;
    _del(key: string): Promise<void>;
    mdelete(keys: string[]): Promise<void>;
    yieldKeys(_prefix: string | undefined): AsyncGenerator<string>;
}
/**
 * Based on https://cloud.google.com/storage/docs/json_api/v1/objects#resource
 */
export interface GoogleCloudStorageObject extends Record<string, unknown> {
    id?: string;
    name?: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
}
export interface GoogleCloudStorageResponse extends GoogleResponse {
    data: GoogleCloudStorageObject;
}
export type BucketAndPath = {
    bucket: string;
    path: string;
};
export declare class GoogleCloudStorageUri {
    static uriRegexp: RegExp;
    bucket: string;
    path: string;
    constructor(uri: string);
    get uri(): string;
    get isValid(): boolean;
    static uriToBucketAndPath(uri: string): BucketAndPath;
    static isValidUri(uri: string): boolean;
}
export interface GoogleCloudStorageConnectionParams {
    uri: string;
}
export interface GoogleCloudStorageUploadConnectionParams<AuthOptions> extends GoogleUploadConnectionParams<AuthOptions>, GoogleCloudStorageConnectionParams {
}
export declare class GoogleCloudStorageUploadConnection<AuthOptions> extends GoogleMultipartUploadConnection<AsyncCallerCallOptions, GoogleCloudStorageResponse, AuthOptions> {
    uri: GoogleCloudStorageUri;
    constructor(fields: GoogleCloudStorageUploadConnectionParams<AuthOptions>, caller: AsyncCaller, client: GoogleAbstractedClient);
    buildUrl(): Promise<string>;
}
export interface GoogleCloudStorageDownloadConnectionParams<AuthOptions> extends GoogleCloudStorageConnectionParams, GoogleConnectionParams<AuthOptions> {
    method: GoogleAbstractedClientOpsMethod;
    alt: "media" | undefined;
}
export declare class GoogleCloudStorageDownloadConnection<ResponseType extends GoogleResponse, AuthOptions> extends GoogleDownloadConnection<AsyncCallerCallOptions, ResponseType, AuthOptions> {
    uri: GoogleCloudStorageUri;
    method: GoogleAbstractedClientOpsMethod;
    alt: "media" | undefined;
    constructor(fields: GoogleCloudStorageDownloadConnectionParams<AuthOptions>, caller: AsyncCaller, client: GoogleAbstractedClient);
    buildMethod(): GoogleAbstractedClientOpsMethod;
    buildUrl(): Promise<string>;
}
export interface GoogleCloudStorageRawConnectionParams<AuthOptions> extends GoogleCloudStorageConnectionParams, GoogleConnectionParams<AuthOptions> {
}
export declare class GoogleCloudStorageRawConnection<AuthOptions> extends GoogleDownloadRawConnection<AsyncCallerCallOptions, AuthOptions> {
    uri: GoogleCloudStorageUri;
    constructor(fields: GoogleCloudStorageRawConnectionParams<AuthOptions>, caller: AsyncCaller, client: GoogleAbstractedClient);
    buildUrl(): Promise<string>;
}
export interface BlobStoreGoogleCloudStorageBaseParams<AuthOptions> extends BlobStoreGoogleParams<AuthOptions> {
    uriPrefix: GoogleCloudStorageUri;
}
export declare abstract class BlobStoreGoogleCloudStorageBase<AuthOptions> extends BlobStoreGoogle<GoogleCloudStorageResponse, AuthOptions> {
    params: BlobStoreGoogleCloudStorageBaseParams<AuthOptions>;
    constructor(fields: BlobStoreGoogleCloudStorageBaseParams<AuthOptions>);
    buildSetConnection([key, _blob]: [
        string,
        MediaBlob
    ]): GoogleMultipartUploadConnection<AsyncCallerCallOptions, GoogleCloudStorageResponse, AuthOptions>;
    buildSetMetadata([key, blob]: [string, MediaBlob]): Record<string, unknown>;
    buildGetMetadataConnection(key: string): GoogleDownloadConnection<AsyncCallerCallOptions, GoogleCloudStorageResponse, AuthOptions>;
    buildGetDataConnection(key: string): GoogleDownloadRawConnection<AsyncCallerCallOptions, AuthOptions>;
    buildDeleteConnection(key: string): GoogleDownloadConnection<AsyncCallerCallOptions, GoogleResponse, AuthOptions>;
}
export type AIStudioFileState = "PROCESSING" | "ACTIVE" | "FAILED" | "STATE_UNSPECIFIED";
export type AIStudioFileVideoMetadata = {
    videoMetadata: {
        videoDuration: string;
    };
};
export type AIStudioFileMetadata = AIStudioFileVideoMetadata;
export interface AIStudioFileObject {
    name?: string;
    displayName?: string;
    mimeType?: string;
    sizeBytes?: string;
    createTime?: string;
    updateTime?: string;
    expirationTime?: string;
    sha256Hash?: string;
    uri?: string;
    state?: AIStudioFileState;
    error?: {
        code: number;
        message: string;
        details: Record<string, unknown>[];
    };
    metadata?: AIStudioFileMetadata;
}
export declare class AIStudioMediaBlob extends MediaBlob {
    _valueAsDate(value: string): Date;
    _metadataFieldAsDate(field: string): Date;
    get createDate(): Date;
    get updateDate(): Date;
    get expirationDate(): Date;
    get isExpired(): boolean;
}
export interface AIStudioFileGetResponse extends GoogleResponse {
    data: AIStudioFileObject;
}
export interface AIStudioFileSaveResponse extends GoogleResponse {
    data: {
        file: AIStudioFileObject;
    };
}
export interface AIStudioFileListResponse extends GoogleResponse {
    data: {
        files: AIStudioFileObject[];
        nextPageToken: string;
    };
}
export type AIStudioFileResponse = AIStudioFileGetResponse | AIStudioFileSaveResponse | AIStudioFileListResponse;
export interface AIStudioFileConnectionParams {
}
export interface AIStudioFileUploadConnectionParams<AuthOptions> extends GoogleUploadConnectionParams<AuthOptions>, AIStudioFileConnectionParams {
}
export declare class AIStudioFileUploadConnection<AuthOptions> extends GoogleMultipartUploadConnection<AsyncCallerCallOptions, AIStudioFileSaveResponse, AuthOptions> {
    apiVersion: string;
    buildUrl(): Promise<string>;
}
export interface AIStudioFileDownloadConnectionParams<AuthOptions> extends AIStudioFileConnectionParams, GoogleConnectionParams<AuthOptions> {
    method: GoogleAbstractedClientOpsMethod;
    name: string;
}
export declare class AIStudioFileDownloadConnection<ResponseType extends GoogleResponse, AuthOptions> extends GoogleDownloadConnection<AsyncCallerCallOptions, ResponseType, AuthOptions> {
    method: GoogleAbstractedClientOpsMethod;
    name: string;
    apiVersion: string;
    constructor(fields: AIStudioFileDownloadConnectionParams<AuthOptions>, caller: AsyncCaller, client: GoogleAbstractedClient);
    buildMethod(): GoogleAbstractedClientOpsMethod;
    buildUrl(): Promise<string>;
}
export interface BlobStoreAIStudioFileBaseParams<AuthOptions> extends BlobStoreGoogleParams<AuthOptions> {
    retryTime?: number;
}
export declare abstract class BlobStoreAIStudioFileBase<AuthOptions> extends BlobStoreGoogle<AIStudioFileResponse, AuthOptions> {
    params?: BlobStoreAIStudioFileBaseParams<AuthOptions>;
    retryTime: number;
    constructor(fields?: BlobStoreAIStudioFileBaseParams<AuthOptions>);
    _pathToName(path: string): string;
    abstract buildAbstractedClient(fields?: BlobStoreGoogleParams<AuthOptions>): GoogleAbstractedClient;
    buildApiKeyClient(apiKey: string): GoogleAbstractedClient;
    buildApiKey(fields?: BlobStoreGoogleParams<AuthOptions>): string | undefined;
    buildClient(fields?: BlobStoreGoogleParams<AuthOptions>): GoogleAbstractedClient;
    _regetMetadata(key: string): Promise<AIStudioFileObject>;
    _set([key, blob]: [
        string,
        MediaBlob
    ]): Promise<AIStudioFileSaveResponse>;
    buildSetConnection([_key, _blob]: [
        string,
        MediaBlob
    ]): GoogleMultipartUploadConnection<AsyncCallerCallOptions, AIStudioFileResponse, AuthOptions>;
    buildSetMetadata([_key, _blob]: [string, MediaBlob]): Record<string, unknown>;
    buildGetMetadataConnection(key: string): GoogleDownloadConnection<AsyncCallerCallOptions, AIStudioFileResponse, AuthOptions>;
    buildGetDataConnection(_key: string): GoogleDownloadRawConnection<AsyncCallerCallOptions, AuthOptions>;
    _get(key: string): Promise<MediaBlob | undefined>;
    buildDeleteConnection(key: string): GoogleDownloadConnection<AsyncCallerCallOptions, AIStudioFileResponse, AuthOptions>;
}
