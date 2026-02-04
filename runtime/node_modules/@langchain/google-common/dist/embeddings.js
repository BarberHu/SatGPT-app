import { Embeddings } from "@langchain/core/embeddings";
import { chunkArray } from "@langchain/core/utils/chunk_array";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { GoogleAIConnection } from "./connection.js";
import { ApiKeyGoogleAuth } from "./auth.js";
class EmbeddingsConnection extends GoogleAIConnection {
    constructor(fields, caller, client, streaming) {
        super(fields, caller, client, streaming);
        Object.defineProperty(this, "convertSystemMessageToHumanContent", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
    }
    async buildUrlMethod() {
        return "predict";
    }
    get modelPublisher() {
        // All the embedding models are currently published by "google"
        return "google";
    }
    async formatData(input, parameters) {
        return {
            instances: input,
            parameters,
        };
    }
}
/**
 * Enables calls to Google APIs for generating
 * text embeddings.
 */
export class BaseGoogleEmbeddings extends Embeddings {
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "model", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.model = fields.model;
        this.connection = new EmbeddingsConnection({ ...fields, ...this }, this.caller, this.buildClient(fields), false);
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
            return this.buildAbstractedClient(fields);
        }
    }
    /**
     * Takes an array of documents as input and returns a promise that
     * resolves to a 2D array of embeddings for each document. It splits the
     * documents into chunks and makes requests to the Google Vertex AI API to
     * generate embeddings.
     * @param documents An array of documents to be embedded.
     * @returns A promise that resolves to a 2D array of embeddings for each document.
     */
    async embedDocuments(documents) {
        const instanceChunks = chunkArray(documents.map((document) => ({
            content: document,
        })), 5); // Vertex AI accepts max 5 instances per prediction
        const parameters = {};
        const options = {};
        const responses = await Promise.all(instanceChunks.map((instances) => this.connection.request(instances, parameters, options)));
        const result = responses
            ?.map((response) => response?.data?.predictions?.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result) => result.embeddings?.values) ?? [])
            .flat() ?? [];
        return result;
    }
    /**
     * Takes a document as input and returns a promise that resolves to an
     * embedding for the document. It calls the embedDocuments method with the
     * document as the input.
     * @param document A document to be embedded.
     * @returns A promise that resolves to an embedding for the document.
     */
    async embedQuery(document) {
        const data = await this.embedDocuments([document]);
        return data[0];
    }
}
