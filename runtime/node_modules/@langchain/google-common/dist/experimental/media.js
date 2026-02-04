import { AsyncCaller, } from "@langchain/core/utils/async_caller";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MediaBlob, BlobStore, } from "./utils/media_core.js";
import { GoogleHostConnection, GoogleRawConnection } from "../connection.js";
import { ApiKeyGoogleAuth, } from "../auth.js";
export class GoogleMultipartUploadConnection extends GoogleHostConnection {
    constructor(fields, caller, client) {
        super(fields, caller, client);
    }
    async _body(separator, data, metadata) {
        const contentType = data.mimetype;
        const { encoded, encoding } = await data.encode();
        const body = [
            `--${separator}`,
            "Content-Type: application/json; charset=UTF-8",
            "",
            JSON.stringify(metadata),
            "",
            `--${separator}`,
            `Content-Type: ${contentType}`,
            `Content-Transfer-Encoding: ${encoding}`,
            "",
            encoded,
            `--${separator}--`,
        ];
        return body.join("\n");
    }
    async request(data, metadata, options) {
        const separator = `separator-${Date.now()}`;
        const body = await this._body(separator, data, metadata);
        const requestHeaders = {
            "Content-Type": `multipart/related; boundary=${separator}`,
            "X-Goog-Upload-Protocol": "multipart",
        };
        const response = this._request(body, options, requestHeaders);
        return response;
    }
}
export class GoogleDownloadConnection extends GoogleHostConnection {
    async request(options) {
        return this._request(undefined, options);
    }
}
export class GoogleDownloadRawConnection extends GoogleRawConnection {
    buildMethod() {
        return "GET";
    }
    async request(options) {
        return this._request(undefined, options);
    }
}
export class BlobStoreGoogle extends BlobStore {
    constructor(fields) {
        super(fields);
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
        this.caller = new AsyncCaller(fields ?? {});
        this.client = this.buildClient(fields);
    }
    async _set(keyValuePair) {
        const [, blob] = keyValuePair;
        const setMetadata = this.buildSetMetadata(keyValuePair);
        const metadata = setMetadata;
        const options = {};
        const connection = this.buildSetConnection(keyValuePair);
        const response = await connection.request(blob, metadata, options);
        return response;
    }
    async mset(keyValuePairs) {
        const ret = keyValuePairs.map((keyValue) => this._set(keyValue));
        await Promise.all(ret);
    }
    async _getMetadata(key) {
        const connection = this.buildGetMetadataConnection(key);
        const options = {};
        const response = await connection.request(options);
        return response.data;
    }
    async _getData(key) {
        const connection = this.buildGetDataConnection(key);
        const options = {};
        const response = await connection.request(options);
        return response.data;
    }
    _getMimetypeFromMetadata(metadata) {
        return metadata.contentType;
    }
    async _get(key) {
        const metadata = await this._getMetadata(key);
        const data = await this._getData(key);
        if (data && metadata) {
            const ret = await MediaBlob.fromBlob(data, { metadata, path: key });
            return ret;
        }
        else {
            return undefined;
        }
    }
    async mget(keys) {
        const ret = keys.map((key) => this._get(key));
        return await Promise.all(ret);
    }
    async _del(key) {
        const connection = this.buildDeleteConnection(key);
        const options = {};
        await connection.request(options);
    }
    async mdelete(keys) {
        const ret = keys.map((key) => this._del(key));
        await Promise.all(ret);
    }
    // eslint-disable-next-line require-yield
    async *yieldKeys(_prefix) {
        // TODO: Implement. Most have an implementation that uses nextToken.
        throw new Error("yieldKeys is not implemented");
    }
}
export class GoogleCloudStorageUri {
    constructor(uri) {
        Object.defineProperty(this, "bucket", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "path", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        const bucketAndPath = GoogleCloudStorageUri.uriToBucketAndPath(uri);
        this.bucket = bucketAndPath.bucket;
        this.path = bucketAndPath.path;
    }
    get uri() {
        return `gs://${this.bucket}/${this.path}`;
    }
    get isValid() {
        return (typeof this.bucket !== "undefined" && typeof this.path !== "undefined");
    }
    static uriToBucketAndPath(uri) {
        const match = this.uriRegexp.exec(uri);
        if (!match) {
            throw new Error(`Invalid gs:// URI: ${uri}`);
        }
        return {
            bucket: match[1],
            path: match[2],
        };
    }
    static isValidUri(uri) {
        return this.uriRegexp.test(uri);
    }
}
Object.defineProperty(GoogleCloudStorageUri, "uriRegexp", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: /gs:\/\/([a-z0-9][a-z0-9._-]+[a-z0-9])\/(.*)/
});
export class GoogleCloudStorageUploadConnection extends GoogleMultipartUploadConnection {
    constructor(fields, caller, client) {
        super(fields, caller, client);
        Object.defineProperty(this, "uri", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.uri = new GoogleCloudStorageUri(fields.uri);
    }
    async buildUrl() {
        return `https://storage.googleapis.com/upload/storage/${this.apiVersion}/b/${this.uri.bucket}/o?uploadType=multipart`;
    }
}
export class GoogleCloudStorageDownloadConnection extends GoogleDownloadConnection {
    constructor(fields, caller, client) {
        super(fields, caller, client);
        Object.defineProperty(this, "uri", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "method", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "alt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.uri = new GoogleCloudStorageUri(fields.uri);
        this.method = fields.method;
        this.alt = fields.alt;
    }
    buildMethod() {
        return this.method;
    }
    async buildUrl() {
        const path = encodeURIComponent(this.uri.path);
        const ret = `https://storage.googleapis.com/storage/${this.apiVersion}/b/${this.uri.bucket}/o/${path}`;
        return this.alt ? `${ret}?alt=${this.alt}` : ret;
    }
}
export class GoogleCloudStorageRawConnection extends GoogleDownloadRawConnection {
    constructor(fields, caller, client) {
        super(fields, caller, client);
        Object.defineProperty(this, "uri", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.uri = new GoogleCloudStorageUri(fields.uri);
    }
    async buildUrl() {
        const path = encodeURIComponent(this.uri.path);
        const ret = `https://storage.googleapis.com/storage/${this.apiVersion}/b/${this.uri.bucket}/o/${path}?alt=media`;
        return ret;
    }
}
export class BlobStoreGoogleCloudStorageBase extends BlobStoreGoogle {
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "params", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.params = fields;
        this.defaultStoreOptions = {
            ...this.defaultStoreOptions,
            pathPrefix: fields.uriPrefix.uri,
        };
    }
    buildSetConnection([key, _blob]) {
        const params = {
            ...this.params,
            uri: key,
        };
        return new GoogleCloudStorageUploadConnection(params, this.caller, this.client);
    }
    buildSetMetadata([key, blob]) {
        const uri = new GoogleCloudStorageUri(key);
        const ret = {
            name: uri.path,
            metadata: blob.metadata,
            contentType: blob.mimetype,
        };
        return ret;
    }
    buildGetMetadataConnection(key) {
        const params = {
            uri: key,
            method: "GET",
            alt: undefined,
        };
        return new GoogleCloudStorageDownloadConnection(params, this.caller, this.client);
    }
    buildGetDataConnection(key) {
        const params = {
            uri: key,
        };
        return new GoogleCloudStorageRawConnection(params, this.caller, this.client);
    }
    buildDeleteConnection(key) {
        const params = {
            uri: key,
            method: "DELETE",
            alt: undefined,
        };
        return new GoogleCloudStorageDownloadConnection(params, this.caller, this.client);
    }
}
export class AIStudioMediaBlob extends MediaBlob {
    _valueAsDate(value) {
        if (!value) {
            return new Date(0);
        }
        return new Date(value);
    }
    _metadataFieldAsDate(field) {
        return this._valueAsDate(this.metadata?.[field]);
    }
    get createDate() {
        return this._metadataFieldAsDate("createTime");
    }
    get updateDate() {
        return this._metadataFieldAsDate("updateTime");
    }
    get expirationDate() {
        return this._metadataFieldAsDate("expirationTime");
    }
    get isExpired() {
        const now = new Date().toISOString();
        const exp = this.metadata?.expirationTime ?? now;
        return exp <= now;
    }
}
export class AIStudioFileUploadConnection extends GoogleMultipartUploadConnection {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "apiVersion", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "v1beta"
        });
    }
    async buildUrl() {
        return `https://generativelanguage.googleapis.com/upload/${this.apiVersion}/files`;
    }
}
export class AIStudioFileDownloadConnection extends GoogleDownloadConnection {
    constructor(fields, caller, client) {
        super(fields, caller, client);
        Object.defineProperty(this, "method", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "apiVersion", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "v1beta"
        });
        this.method = fields.method;
        this.name = fields.name;
    }
    buildMethod() {
        return this.method;
    }
    async buildUrl() {
        return `https://generativelanguage.googleapis.com/${this.apiVersion}/files/${this.name}`;
    }
}
export class BlobStoreAIStudioFileBase extends BlobStoreGoogle {
    constructor(fields) {
        const params = {
            defaultStoreOptions: {
                pathPrefix: "https://generativelanguage.googleapis.com/v1beta/files/",
                actionIfInvalid: "removePath",
            },
            ...fields,
        };
        super(params);
        Object.defineProperty(this, "params", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "retryTime", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 1000
        });
        this.params = params;
        this.retryTime = params?.retryTime ?? this.retryTime ?? 1000;
    }
    _pathToName(path) {
        return path.split("/").pop() ?? path;
    }
    buildApiKeyClient(apiKey) {
        return new ApiKeyGoogleAuth(apiKey);
    }
    buildApiKey(fields) {
        return fields?.apiKey ?? getEnvironmentVariable("GOOGLE_API_KEY");
    }
    buildClient(fields) {
        const apiKey = this.buildApiKey(fields);
        if (apiKey) {
            return this.buildApiKeyClient(apiKey);
        }
        else {
            // TODO: Test that you can use OAuth to access
            return this.buildAbstractedClient(fields);
        }
    }
    async _regetMetadata(key) {
        // Sleep for some time period
        // eslint-disable-next-line no-promise-executor-return
        await new Promise((resolve) => setTimeout(resolve, this.retryTime));
        // Fetch the latest metadata
        return this._getMetadata(key);
    }
    async _set([key, blob]) {
        const response = (await super._set([
            key,
            blob,
        ]));
        let file = response.data?.file ?? { state: "FAILED" };
        while (file.state === "PROCESSING" && file.uri && this.retryTime > 0) {
            file = await this._regetMetadata(file.uri);
        }
        // The response should contain the name (and valid URI), so we need to
        // update the blob with this. We can't return a new blob, since mset()
        // doesn't return anything.
        /* eslint-disable no-param-reassign */
        blob.path = file.uri;
        blob.metadata = {
            ...blob.metadata,
            ...file,
        };
        /* eslint-enable no-param-reassign */
        return response;
    }
    buildSetConnection([_key, _blob]) {
        return new AIStudioFileUploadConnection(this.params, this.caller, this.client);
    }
    buildSetMetadata([_key, _blob]) {
        return {};
    }
    buildGetMetadataConnection(key) {
        const params = {
            ...this.params,
            method: "GET",
            name: this._pathToName(key),
        };
        return new AIStudioFileDownloadConnection(params, this.caller, this.client);
    }
    buildGetDataConnection(_key) {
        throw new Error("AI Studio File API does not provide data");
    }
    async _get(key) {
        const metadata = await this._getMetadata(key);
        if (metadata) {
            const contentType = metadata?.mimeType ?? "application/octet-stream";
            // TODO - Get the actual data (and other metadata) from an optional backing store
            const data = {
                value: "",
                type: contentType,
            };
            return new MediaBlob({
                path: key,
                data,
                metadata,
            });
        }
        else {
            return undefined;
        }
    }
    buildDeleteConnection(key) {
        const params = {
            ...this.params,
            method: "DELETE",
            name: this._pathToName(key),
        };
        return new AIStudioFileDownloadConnection(params, this.caller, this.client);
    }
}
