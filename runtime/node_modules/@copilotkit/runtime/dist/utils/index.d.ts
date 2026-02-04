declare enum ResponseStatusCode {
    Pending = "pending",
    Success = "success",
    Failed = "failed"
}
declare abstract class BaseResponseStatus {
    code: ResponseStatusCode;
}
declare enum FailedResponseStatusReason {
    GUARDRAILS_VALIDATION_FAILED = "GUARDRAILS_VALIDATION_FAILED",
    MESSAGE_STREAM_INTERRUPTED = "MESSAGE_STREAM_INTERRUPTED",
    UNKNOWN_ERROR = "UNKNOWN_ERROR"
}
declare class FailedResponseStatus extends BaseResponseStatus {
    code: ResponseStatusCode;
    reason: FailedResponseStatusReason;
    details?: Record<string, any>;
}

declare class GuardrailsValidationFailureResponse extends FailedResponseStatus {
    reason: FailedResponseStatusReason;
    details: {
        guardrailsReason: string;
    };
    constructor({ guardrailsReason }: {
        guardrailsReason: any;
    });
}
declare class MessageStreamInterruptedResponse extends FailedResponseStatus {
    reason: FailedResponseStatusReason;
    details: {
        messageId: string;
        description: string;
    };
    constructor({ messageId }: {
        messageId: string;
    });
}
declare class UnknownErrorResponse extends FailedResponseStatus {
    reason: FailedResponseStatusReason;
    details: {
        description?: string;
        originalError?: {
            code?: string;
            statusCode?: number;
            severity?: string;
            visibility?: string;
            originalErrorType?: string;
            extensions?: any;
        };
    };
    constructor({ description, originalError, }: {
        description?: string;
        originalError?: {
            code?: string;
            statusCode?: number;
            severity?: string;
            visibility?: string;
            originalErrorType?: string;
            extensions?: any;
        };
    });
}

export { GuardrailsValidationFailureResponse, MessageStreamInterruptedResponse, UnknownErrorResponse };
