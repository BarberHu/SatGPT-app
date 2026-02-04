"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaManager = exports.DataBlobStore = exports.SimpleWebBlobStore = exports.ReadThroughBlobStore = exports.BackedBlobStore = exports.BlobStore = exports.MediaBlob = void 0;
const uuid_1 = require("uuid"); // FIXME - it is importing the wrong uuid, so v6 and v7 aren't implemented
const stores_1 = require("@langchain/core/stores");
const serializable_1 = require("@langchain/core/load/serializable");
function bytesToString(dataArray) {
    // Need to handle the array in smaller chunks to deal with stack size limits
    let ret = "";
    const chunkSize = 102400;
    for (let i = 0; i < dataArray.length; i += chunkSize) {
        const chunk = dataArray.subarray(i, i + chunkSize);
        ret += String.fromCharCode(...chunk);
    }
    return ret;
}
/**
 * Represents a chunk of data that can be identified by the path where the
 * data is (or will be) located, along with optional metadata about the data.
 */
class MediaBlob extends serializable_1.Serializable {
    constructor(params) {
        super(params);
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: [
                "langchain",
                "google_common",
                "experimental",
                "utils",
                "media_core",
            ]
        });
        Object.defineProperty(this, "data", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                value: "",
                type: "text/plain",
            }
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.defineProperty(this, "metadata", {
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
        this.data = params.data ?? this.data;
        this.metadata = params.metadata;
        this.path = params.path;
    }
    get size() {
        return this.asBytes.length;
    }
    get dataType() {
        return this.data?.type ?? "";
    }
    get encoding() {
        const charsetEquals = this.dataType.indexOf("charset=");
        return charsetEquals === -1
            ? "utf-8"
            : this.dataType.substring(charsetEquals + 8);
    }
    get mimetype() {
        const semicolon = this.dataType.indexOf(";");
        return semicolon === -1
            ? this.dataType
            : this.dataType.substring(0, semicolon);
    }
    get asBytes() {
        if (!this.data) {
            return Uint8Array.from([]);
        }
        const binString = atob(this.data?.value);
        const ret = new Uint8Array(binString.length);
        for (let co = 0; co < binString.length; co += 1) {
            ret[co] = binString.charCodeAt(co);
        }
        return ret;
    }
    async asString() {
        return bytesToString(this.asBytes);
    }
    async asBase64() {
        return this.data?.value ?? "";
    }
    async asDataUrl() {
        return `data:${this.mimetype};base64,${await this.asBase64()}`;
    }
    async asUri() {
        return this.path ?? (await this.asDataUrl());
    }
    async encode() {
        const dataUrl = await this.asDataUrl();
        const comma = dataUrl.indexOf(",");
        const encoded = dataUrl.substring(comma + 1);
        const encoding = dataUrl.indexOf("base64") > -1 ? "base64" : "8bit";
        return {
            encoded,
            encoding,
        };
    }
    static fromDataUrl(url) {
        if (!url.startsWith("data:")) {
            throw new Error("Not a data: URL");
        }
        const colon = url.indexOf(":");
        const semicolon = url.indexOf(";");
        const mimeType = url.substring(colon + 1, semicolon);
        const comma = url.indexOf(",");
        const base64Data = url.substring(comma + 1);
        const data = {
            type: mimeType,
            value: base64Data,
        };
        return new MediaBlob({
            data,
            path: url,
        });
    }
    static async fromBlob(blob, other) {
        const valueBuffer = await blob.arrayBuffer();
        const valueArray = new Uint8Array(valueBuffer);
        const valueStr = bytesToString(valueArray);
        const value = btoa(valueStr);
        return new MediaBlob({
            ...other,
            data: {
                value,
                type: blob.type,
            },
        });
    }
}
exports.MediaBlob = MediaBlob;
/**
 * A specialized Store that is designed to handle MediaBlobs and use the
 * key that is included in the blob to determine exactly how it is stored.
 *
 * The full details of a MediaBlob may be changed when it is stored.
 * For example, it may get additional or different Metadata. This should be
 * what is returned when the store() method is called.
 *
 * Although BlobStore extends BaseStore, not all of the methods from
 * BaseStore may be implemented (or even possible). Those that are not
 * implemented should be documented and throw an Error if called.
 */
class BlobStore extends stores_1.BaseStore {
    constructor(opts) {
        super(opts);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain", "google-common"]
        }); // FIXME - What should this be? And why?
        Object.defineProperty(this, "defaultStoreOptions", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "defaultFetchOptions", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.defaultStoreOptions = opts?.defaultStoreOptions ?? {};
        this.defaultFetchOptions = opts?.defaultFetchOptions ?? {};
    }
    async _realKey(key) {
        return typeof key === "string" ? key : await key.asUri();
    }
    /**
     * Is the path supported by this BlobStore?
     *
     * Although this is async, this is expected to be a relatively fast operation
     * (ie - you shouldn't make network calls).
     *
     * @param path The path to check
     * @param opts Any options (if needed) that may be used to determine if it is valid
     * @return If the path is supported
     */
    hasValidPath(path, opts) {
        const prefix = opts?.pathPrefix ?? "";
        const isPrefixed = typeof path !== "undefined" && path.startsWith(prefix);
        return Promise.resolve(isPrefixed);
    }
    _blobPathSuffix(blob) {
        // Get the path currently set and make sure we treat it as a string
        const blobPath = `${blob.path}`;
        // Advance past the first set of /
        let pathStart = blobPath.indexOf("/") + 1;
        while (blobPath.charAt(pathStart) === "/") {
            pathStart += 1;
        }
        // We will use the rest as the path for a replacement
        return blobPath.substring(pathStart);
    }
    async _newBlob(oldBlob, newPath) {
        const oldPath = oldBlob.path;
        const metadata = oldBlob?.metadata ?? {};
        metadata.langchainOldPath = oldPath;
        const newBlob = new MediaBlob({
            ...oldBlob,
            metadata,
        });
        if (newPath) {
            newBlob.path = newPath;
        }
        else if (newBlob.path) {
            delete newBlob.path;
        }
        return newBlob;
    }
    async _validBlobPrefixPath(blob, opts) {
        const prefix = opts?.pathPrefix ?? "";
        const suffix = this._blobPathSuffix(blob);
        const newPath = `${prefix}${suffix}`;
        return this._newBlob(blob, newPath);
    }
    _validBlobPrefixUuidFunction(name) {
        switch (name) {
            case "prefixUuid1":
                return (0, uuid_1.v1)();
            case "prefixUuid4":
                return (0, uuid_1.v4)();
            // case "prefixUuid6": return v6();
            // case "prefixUuid7": return v7();
            default:
                throw new Error(`Unknown uuid function: ${name}`);
        }
    }
    async _validBlobPrefixUuid(blob, opts) {
        const prefix = opts?.pathPrefix ?? "";
        const suffix = this._validBlobPrefixUuidFunction(opts?.actionIfInvalid ?? "prefixUuid4");
        const newPath = `${prefix}${suffix}`;
        return this._newBlob(blob, newPath);
    }
    async _validBlobRemovePath(blob, _opts) {
        return this._newBlob(blob, undefined);
    }
    /**
     * Based on the blob and options, return a blob that has a valid path
     * that can be saved.
     * @param blob
     * @param opts
     */
    async _validStoreBlob(blob, opts) {
        if (await this.hasValidPath(blob.path, opts)) {
            return blob;
        }
        switch (opts?.actionIfInvalid) {
            case "ignore":
                return blob;
            case "prefixPath":
                return this._validBlobPrefixPath(blob, opts);
            case "prefixUuid1":
            case "prefixUuid4":
            case "prefixUuid6":
            case "prefixUuid7":
                return this._validBlobPrefixUuid(blob, opts);
            case "removePath":
                return this._validBlobRemovePath(blob, opts);
            default:
                return undefined;
        }
    }
    async store(blob, opts = {}) {
        const allOpts = {
            ...this.defaultStoreOptions,
            ...opts,
        };
        const validBlob = await this._validStoreBlob(blob, allOpts);
        if (typeof validBlob !== "undefined") {
            const validKey = await validBlob.asUri();
            await this.mset([[validKey, validBlob]]);
            const savedKey = await validBlob.asUri();
            return await this.fetch(savedKey);
        }
        return undefined;
    }
    async _missingFetchBlobEmpty(path, _opts) {
        return new MediaBlob({ path });
    }
    async _missingFetchBlob(path, opts) {
        switch (opts?.actionIfBlobMissing) {
            case "emptyBlob":
                return this._missingFetchBlobEmpty(path, opts);
            default:
                return undefined;
        }
    }
    async fetch(key, opts = {}) {
        const allOpts = {
            ...this.defaultFetchOptions,
            ...opts,
        };
        const realKey = await this._realKey(key);
        const ret = await this.mget([realKey]);
        return ret?.[0] ?? (await this._missingFetchBlob(realKey, allOpts));
    }
}
exports.BlobStore = BlobStore;
class BackedBlobStore extends BlobStore {
    constructor(opts) {
        super(opts);
        Object.defineProperty(this, "backingStore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.backingStore = opts.backingStore;
    }
    mdelete(keys) {
        return this.backingStore.mdelete(keys);
    }
    mget(keys) {
        return this.backingStore.mget(keys);
    }
    mset(keyValuePairs) {
        return this.backingStore.mset(keyValuePairs);
    }
    yieldKeys(prefix) {
        return this.backingStore.yieldKeys(prefix);
    }
}
exports.BackedBlobStore = BackedBlobStore;
class ReadThroughBlobStore extends BlobStore {
    constructor(opts) {
        super(opts);
        Object.defineProperty(this, "baseStore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "backingStore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.baseStore = opts.baseStore;
        this.backingStore = opts.backingStore;
    }
    async store(blob, opts = {}) {
        const originalUri = await blob.asUri();
        const newBlob = await this.backingStore.store(blob, opts);
        if (newBlob) {
            await this.baseStore.mset([[originalUri, newBlob]]);
        }
        return newBlob;
    }
    mdelete(keys) {
        return this.baseStore.mdelete(keys);
    }
    mget(keys) {
        return this.baseStore.mget(keys);
    }
    mset(_keyValuePairs) {
        throw new Error("Do not call ReadThroughBlobStore.mset directly");
    }
    yieldKeys(prefix) {
        return this.baseStore.yieldKeys(prefix);
    }
}
exports.ReadThroughBlobStore = ReadThroughBlobStore;
class SimpleWebBlobStore extends BlobStore {
    _notImplementedException() {
        throw new Error("Not implemented for SimpleWebBlobStore");
    }
    async hasValidPath(path, _opts) {
        return ((await super.hasValidPath(path, { pathPrefix: "https://" })) ||
            (await super.hasValidPath(path, { pathPrefix: "http://" })));
    }
    async _fetch(url) {
        const ret = new MediaBlob({
            path: url,
        });
        const metadata = {};
        const fetchOptions = {
            method: "GET",
        };
        const res = await fetch(url, fetchOptions);
        metadata.status = res.status;
        const headers = {};
        for (const [key, value] of res.headers.entries()) {
            headers[key] = value;
        }
        metadata.headers = headers;
        metadata.ok = res.ok;
        if (res.ok) {
            const resMediaBlob = await MediaBlob.fromBlob(await res.blob());
            ret.data = resMediaBlob.data;
        }
        ret.metadata = metadata;
        return ret;
    }
    async mget(keys) {
        const blobMap = keys.map(this._fetch);
        return await Promise.all(blobMap);
    }
    async mdelete(_keys) {
        this._notImplementedException();
    }
    async mset(_keyValuePairs) {
        this._notImplementedException();
    }
    async *yieldKeys(_prefix) {
        this._notImplementedException();
        yield "";
    }
}
exports.SimpleWebBlobStore = SimpleWebBlobStore;
/**
 * A blob "store" that works with data: URLs that will turn the URL into
 * a blob.
 */
class DataBlobStore extends BlobStore {
    _notImplementedException() {
        throw new Error("Not implemented for DataBlobStore");
    }
    hasValidPath(path, _opts) {
        return super.hasValidPath(path, { pathPrefix: "data:" });
    }
    _fetch(url) {
        return MediaBlob.fromDataUrl(url);
    }
    async mget(keys) {
        const blobMap = keys.map(this._fetch);
        return blobMap;
    }
    async mdelete(_keys) {
        this._notImplementedException();
    }
    async mset(_keyValuePairs) {
        this._notImplementedException();
    }
    async *yieldKeys(_prefix) {
        this._notImplementedException();
        yield "";
    }
}
exports.DataBlobStore = DataBlobStore;
/**
 * Responsible for converting a URI (typically a web URL) into a MediaBlob.
 * Allows for aliasing / caching of the requested URI and what it resolves to.
 * This MediaBlob is expected to be usable to provide to an LLM, either
 * through the Base64 of the media or through a canonical URI that the LLM
 * supports.
 */
class MediaManager {
    constructor(config) {
        Object.defineProperty(this, "store", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "resolvers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.store = config.store;
        this.resolvers = config.resolvers;
    }
    defaultResolvers() {
        return [new DataBlobStore({}), new SimpleWebBlobStore({})];
    }
    async _isInvalid(blob) {
        return typeof blob === "undefined";
    }
    /**
     * Given the public URI, load what is at this URI and save it
     * in the store.
     * @param uri The URI to resolve using the resolver
     * @return A canonical MediaBlob for this URI
     */
    async _resolveAndSave(uri) {
        let resolvedBlob;
        const resolvers = this.resolvers || this.defaultResolvers();
        for (let co = 0; co < resolvers.length; co += 1) {
            const resolver = resolvers[co];
            if (await resolver.hasValidPath(uri)) {
                resolvedBlob = await resolver.fetch(uri);
            }
        }
        if (resolvedBlob) {
            return await this.store.store(resolvedBlob);
        }
        else {
            return new MediaBlob({});
        }
    }
    async getMediaBlob(uri) {
        const aliasBlob = await this.store.fetch(uri);
        const ret = (await this._isInvalid(aliasBlob))
            ? await this._resolveAndSave(uri)
            : aliasBlob;
        return ret;
    }
}
exports.MediaManager = MediaManager;
