import { Embeddings, EmbeddingsParams } from "@langchain/core/embeddings";
import { AsyncCallerCallOptions } from "@langchain/core/utils/async_caller";
import { GoogleAbstractedClient } from "./auth.js";
import { GoogleConnectionParams, GoogleResponse } from "./types.js";
/**
 * Defines the parameters required to initialize a
 * GoogleEmbeddings instance. It extends EmbeddingsParams and
 * GoogleConnectionParams.
 */
export interface BaseGoogleEmbeddingsParams<AuthOptions> extends EmbeddingsParams, GoogleConnectionParams<AuthOptions> {
    model: string;
}
/**
 * Defines additional options specific to the
 * GoogleEmbeddingsInstance. It extends AsyncCallerCallOptions.
 */
export interface BaseGoogleEmbeddingsOptions extends AsyncCallerCallOptions {
}
/**
 * Represents an instance for generating embeddings using the Google
 * Vertex AI API. It contains the content to be embedded.
 */
export interface GoogleEmbeddingsInstance {
    content: string;
}
/**
 * Defines the structure of the embeddings results returned by the Google
 * Vertex AI API. It extends GoogleBasePrediction and contains the
 * embeddings and their statistics.
 */
export interface GoogleEmbeddingsResponse extends GoogleResponse {
    data: {
        predictions: {
            embeddings: {
                statistics: {
                    token_count: number;
                    truncated: boolean;
                };
                values: number[];
            };
        }[];
    };
}
/**
 * Enables calls to Google APIs for generating
 * text embeddings.
 */
export declare abstract class BaseGoogleEmbeddings<AuthOptions> extends Embeddings implements BaseGoogleEmbeddingsParams<AuthOptions> {
    model: string;
    private connection;
    constructor(fields: BaseGoogleEmbeddingsParams<AuthOptions>);
    abstract buildAbstractedClient(fields?: GoogleConnectionParams<AuthOptions>): GoogleAbstractedClient;
    buildApiKeyClient(apiKey: string): GoogleAbstractedClient;
    buildApiKey(fields?: GoogleConnectionParams<AuthOptions>): string | undefined;
    buildClient(fields?: GoogleConnectionParams<AuthOptions>): GoogleAbstractedClient;
    /**
     * Takes an array of documents as input and returns a promise that
     * resolves to a 2D array of embeddings for each document. It splits the
     * documents into chunks and makes requests to the Google Vertex AI API to
     * generate embeddings.
     * @param documents An array of documents to be embedded.
     * @returns A promise that resolves to a 2D array of embeddings for each document.
     */
    embedDocuments(documents: string[]): Promise<number[][]>;
    /**
     * Takes a document as input and returns a promise that resolves to an
     * embedding for the document. It calls the embedDocuments method with the
     * document as the input.
     * @param document A document to be embedded.
     * @returns A promise that resolves to an embedding for the document.
     */
    embedQuery(document: string): Promise<number[]>;
}
