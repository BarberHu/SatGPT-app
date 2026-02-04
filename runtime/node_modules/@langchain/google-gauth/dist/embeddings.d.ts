import { GoogleAbstractedClient, GoogleConnectionParams, BaseGoogleEmbeddings, BaseGoogleEmbeddingsParams } from "@langchain/google-common";
import { GoogleAuthOptions } from "google-auth-library";
/**
 * Input to LLM class.
 */
export interface GoogleEmbeddingsInput extends BaseGoogleEmbeddingsParams<GoogleAuthOptions> {
}
/**
 * Integration with an Google embeddings model.
 */
export declare class GoogleEmbeddings extends BaseGoogleEmbeddings<GoogleAuthOptions> implements GoogleEmbeddingsInput {
    static lc_name(): string;
    lc_serializable: boolean;
    constructor(fields: GoogleEmbeddingsInput);
    buildAbstractedClient(fields?: GoogleConnectionParams<GoogleAuthOptions>): GoogleAbstractedClient;
}
