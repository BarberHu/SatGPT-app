import { GoogleAbstractedClient } from "@langchain/google-common";
import { BlobStoreGoogleCloudStorageBase, BlobStoreGoogleCloudStorageBaseParams, BlobStoreAIStudioFileBase, BlobStoreAIStudioFileBaseParams } from "@langchain/google-common/experimental/media";
import { GoogleAuthOptions } from "google-auth-library";
export interface BlobStoreGoogleCloudStorageParams extends BlobStoreGoogleCloudStorageBaseParams<GoogleAuthOptions> {
}
export declare class BlobStoreGoogleCloudStorage extends BlobStoreGoogleCloudStorageBase<GoogleAuthOptions> {
    buildClient(fields?: BlobStoreGoogleCloudStorageParams): GoogleAbstractedClient;
}
export interface BlobStoreAIStudioFileParams extends BlobStoreAIStudioFileBaseParams<GoogleAuthOptions> {
}
export declare class BlobStoreAIStudioFile extends BlobStoreAIStudioFileBase<GoogleAuthOptions> {
    buildAbstractedClient(fields?: BlobStoreAIStudioFileParams): GoogleAbstractedClient;
}
