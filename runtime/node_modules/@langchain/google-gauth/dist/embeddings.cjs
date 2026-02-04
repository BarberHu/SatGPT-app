"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleEmbeddings = void 0;
const google_common_1 = require("@langchain/google-common");
const auth_js_1 = require("./auth.cjs");
/**
 * Integration with an Google embeddings model.
 */
class GoogleEmbeddings extends google_common_1.BaseGoogleEmbeddings {
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
        return new auth_js_1.GAuthClient(fields);
    }
}
exports.GoogleEmbeddings = GoogleEmbeddings;
