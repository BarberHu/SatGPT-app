"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkdownGoogleSearchOutputParser = exports.SimpleGoogleSearchOutputParser = exports.BaseGoogleSearchOutputParser = void 0;
const output_parsers_1 = require("@langchain/core/output_parsers");
class BaseGoogleSearchOutputParser extends output_parsers_1.BaseLLMOutputParser {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["google_common", "output_parsers"]
        });
    }
    generationToGroundingInfo(generation) {
        if ("message" in generation) {
            const responseMetadata = generation?.message?.response_metadata;
            const metadata = responseMetadata?.groundingMetadata;
            const supports = responseMetadata?.groundingSupport ?? metadata?.groundingSupports ?? [];
            if (metadata) {
                return {
                    metadata,
                    supports,
                };
            }
        }
        return undefined;
    }
    generationsToGroundingInfo(generations) {
        for (const generation of generations) {
            const info = this.generationToGroundingInfo(generation);
            if (info !== undefined) {
                return info;
            }
        }
        return undefined;
    }
    generationToString(generation) {
        if ("message" in generation) {
            const content = generation?.message?.content;
            if (typeof content === "string") {
                return content;
            }
            else {
                return content
                    .map((c) => {
                    if (c?.type === "text") {
                        return c?.text ?? "";
                    }
                    else {
                        return "";
                    }
                })
                    .reduce((previousValue, currentValue) => `${previousValue}${currentValue}`);
            }
        }
        return generation.text;
    }
    generationsToString(generations) {
        return generations
            .map((generation) => this.generationToString(generation))
            .reduce((previousValue, currentValue) => `${previousValue}${currentValue}`);
    }
    annotateSegment(text, grounding, support, index) {
        const start = support.segment.startIndex ?? 0;
        const end = support.segment.endIndex;
        const textBefore = text.substring(0, start);
        const textSegment = text.substring(start, end);
        const textAfter = text.substring(end);
        const textPrefix = this.segmentPrefix(grounding, support, index) ?? "";
        const textSuffix = this.segmentSuffix(grounding, support, index) ?? "";
        return `${textBefore}${textPrefix}${textSegment}${textSuffix}${textAfter}`;
    }
    annotateTextSegments(text, grounding) {
        // Go through each support info in reverse, since the segment info
        // is sorted, and we won't need to adjust string indexes this way.
        let ret = text;
        for (let co = grounding.supports.length - 1; co >= 0; co -= 1) {
            const support = grounding.supports[co];
            ret = this.annotateSegment(ret, grounding, support, co);
        }
        return ret;
    }
    /**
     * Google requires us to
     * "Display the Search Suggestion exactly as provided without any modifications"
     * So this will typically be called from the textSuffix() method to get
     * a string that renders HTML.
     * See https://ai.google.dev/gemini-api/docs/grounding/search-suggestions
     * @param grounding
     */
    searchSuggestion(grounding) {
        return grounding?.metadata?.searchEntryPoint?.renderedContent ?? "";
    }
    annotateText(text, grounding) {
        const prefix = this.textPrefix(text, grounding) ?? "";
        const suffix = this.textSuffix(text, grounding) ?? "";
        const body = this.annotateTextSegments(text, grounding);
        return `${prefix}${body}${suffix}`;
    }
    async parseResult(generations, _callbacks) {
        const text = this.generationsToString(generations);
        const grounding = this.generationsToGroundingInfo(generations);
        if (!grounding) {
            return text;
        }
        return this.annotateText(text, grounding);
    }
}
exports.BaseGoogleSearchOutputParser = BaseGoogleSearchOutputParser;
class SimpleGoogleSearchOutputParser extends BaseGoogleSearchOutputParser {
    segmentPrefix(_grounding, _support, _index) {
        return undefined;
    }
    segmentSuffix(_grounding, support, _index) {
        const indices = support.groundingChunkIndices.map((i) => i + 1);
        return ` [${indices.join(", ")}]`;
    }
    textPrefix(_text, _grounding) {
        return "Google Says:\n";
    }
    chunkToString(chunk, index) {
        const info = chunk.retrievedContext ?? chunk.web;
        return `${index + 1}. ${info.title} - ${info.uri}`;
    }
    textSuffix(_text, grounding) {
        let ret = "\n";
        const chunks = grounding?.metadata?.groundingChunks ?? [];
        chunks.forEach((chunk, index) => {
            ret = `${ret}${this.chunkToString(chunk, index)}\n`;
        });
        return ret;
    }
}
exports.SimpleGoogleSearchOutputParser = SimpleGoogleSearchOutputParser;
class MarkdownGoogleSearchOutputParser extends BaseGoogleSearchOutputParser {
    segmentPrefix(_grounding, _support, _index) {
        return undefined;
    }
    chunkLink(grounding, index) {
        const chunk = grounding.metadata.groundingChunks[index];
        const url = chunk.retrievedContext?.uri ?? chunk.web?.uri;
        const num = index + 1;
        return `[[${num}](${url})]`;
    }
    segmentSuffix(grounding, support, _index) {
        let ret = "";
        support.groundingChunkIndices.forEach((chunkIndex) => {
            const link = this.chunkLink(grounding, chunkIndex);
            ret = `${ret}${link}`;
        });
        return ret;
    }
    textPrefix(_text, _grounding) {
        return undefined;
    }
    chunkSuffixLink(chunk, index) {
        const num = index + 1;
        const info = chunk.retrievedContext ?? chunk.web;
        const url = info.uri;
        const site = info.title;
        return `${num}. [${site}](${url})`;
    }
    textSuffix(_text, grounding) {
        let ret = "\n**Search Sources**\n";
        const chunks = grounding.metadata.groundingChunks;
        chunks.forEach((chunk, index) => {
            ret = `${ret}${this.chunkSuffixLink(chunk, index)}\n`;
        });
        const search = this.searchSuggestion(grounding);
        ret = `${ret}\n${search}`;
        return ret;
    }
}
exports.MarkdownGoogleSearchOutputParser = MarkdownGoogleSearchOutputParser;
