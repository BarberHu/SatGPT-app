"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiToolAttributes = exports.GeminiSearchToolAttributes = exports.GoogleAISafetyMethod = exports.GoogleAISafetyThreshold = exports.GoogleAISafetyCategory = void 0;
__exportStar(require("./types-anthropic.cjs"), exports);
exports.GoogleAISafetyCategory = {
    Harassment: "HARM_CATEGORY_HARASSMENT",
    HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HateSpeech: "HARM_CATEGORY_HATE_SPEECH",
    HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    SexuallyExplicit: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    Dangerous: "HARM_CATEGORY_DANGEROUS",
    DANGEROUS: "HARM_CATEGORY_DANGEROUS",
    HARM_CATEGORY_DANGEROUS: "HARM_CATEGORY_DANGEROUS",
    CivicIntegrity: "HARM_CATEGORY_CIVIC_INTEGRITY",
    CIVIC_INTEGRITY: "HARM_CATEGORY_CIVIC_INTEGRITY",
    HARM_CATEGORY_CIVIC_INTEGRITY: "HARM_CATEGORY_CIVIC_INTEGRITY",
};
exports.GoogleAISafetyThreshold = {
    None: "BLOCK_NONE",
    NONE: "BLOCK_NONE",
    BLOCK_NONE: "BLOCK_NONE",
    Few: "BLOCK_ONLY_HIGH",
    FEW: "BLOCK_ONLY_HIGH",
    BLOCK_ONLY_HIGH: "BLOCK_ONLY_HIGH",
    Some: "BLOCK_MEDIUM_AND_ABOVE",
    SOME: "BLOCK_MEDIUM_AND_ABOVE",
    BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE",
    Most: "BLOCK_LOW_AND_ABOVE",
    MOST: "BLOCK_LOW_AND_ABOVE",
    BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE",
    Off: "OFF",
    OFF: "OFF",
    BLOCK_OFF: "OFF",
};
exports.GoogleAISafetyMethod = {
    Severity: "SEVERITY",
    Probability: "PROBABILITY",
};
exports.GeminiSearchToolAttributes = [
    "googleSearchRetrieval",
    "googleSearch",
];
exports.GeminiToolAttributes = [
    "functionDeclaration",
    "retrieval",
    ...exports.GeminiSearchToolAttributes,
];
