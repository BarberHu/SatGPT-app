import { BaseGoogleEmbeddings, } from "@langchain/google-common";
import { GAuthClient } from "./auth.js";
/**
 * Integration with an Google embeddings model.
 */
export class GoogleEmbeddings extends BaseGoogleEmbeddings {
    // Used for tracing, replace with the same name as your class
    static lc_name() {
        return "GoogleEmbeddings";
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
    }
    buildAbstractedClient(fields) {
        return new GAuthClient(fields);
    }
}
