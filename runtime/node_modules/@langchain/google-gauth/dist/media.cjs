"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlobStoreAIStudioFile = exports.BlobStoreGoogleCloudStorage = void 0;
const media_1 = require("@langchain/google-common/experimental/media");
const auth_js_1 = require("./auth.cjs");
class BlobStoreGoogleCloudStorage extends media_1.BlobStoreGoogleCloudStorageBase {
    buildClient(fields) {
        return new auth_js_1.GAuthClient(fields);
    }
}
exports.BlobStoreGoogleCloudStorage = BlobStoreGoogleCloudStorage;
class BlobStoreAIStudioFile extends media_1.BlobStoreAIStudioFileBase {
    buildAbstractedClient(fields) {
        return new auth_js_1.GAuthClient(fields);
    }
}
exports.BlobStoreAIStudioFile = BlobStoreAIStudioFile;
