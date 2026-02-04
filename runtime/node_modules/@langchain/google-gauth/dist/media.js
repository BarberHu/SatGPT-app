import { BlobStoreGoogleCloudStorageBase, BlobStoreAIStudioFileBase, } from "@langchain/google-common/experimental/media";
import { GAuthClient } from "./auth.js";
export class BlobStoreGoogleCloudStorage extends BlobStoreGoogleCloudStorageBase {
    buildClient(fields) {
        return new GAuthClient(fields);
    }
}
export class BlobStoreAIStudioFile extends BlobStoreAIStudioFileBase {
    buildAbstractedClient(fields) {
        return new GAuthClient(fields);
    }
}
