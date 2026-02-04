import type { z } from "zod";
import { GeminiFunctionSchema, GeminiJsonSchema } from "../types.js";
export declare function removeAdditionalProperties(obj: Record<string, any>): GeminiJsonSchema;
export declare function zodToGeminiParameters(zodObj: z.ZodType<any>): GeminiFunctionSchema;
export declare function jsonSchemaToGeminiParameters(schema: Record<string, any>): GeminiFunctionSchema;
