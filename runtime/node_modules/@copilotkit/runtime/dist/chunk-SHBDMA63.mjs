import {
  BaseMessageInput
} from "./chunk-2OZAGFV3.mjs";
import {
  __name
} from "./chunk-FHD4JECV.mjs";

// src/graphql/types/converted/index.ts
var Message = class extends BaseMessageInput {
  type;
  isTextMessage() {
    return this.type === "TextMessage";
  }
  isActionExecutionMessage() {
    return this.type === "ActionExecutionMessage";
  }
  isResultMessage() {
    return this.type === "ResultMessage";
  }
  isAgentStateMessage() {
    return this.type === "AgentStateMessage";
  }
  isImageMessage() {
    return this.type === "ImageMessage";
  }
};
__name(Message, "Message");
var TextMessage = class extends Message {
  type = "TextMessage";
  content;
  role;
  parentMessageId;
};
__name(TextMessage, "TextMessage");
var ActionExecutionMessage = class extends Message {
  type = "ActionExecutionMessage";
  name;
  arguments;
  parentMessageId;
};
__name(ActionExecutionMessage, "ActionExecutionMessage");
var ResultMessage = class extends Message {
  type = "ResultMessage";
  actionExecutionId;
  actionName;
  result;
  static encodeResult(result, error) {
    const errorObj = error ? typeof error === "string" ? {
      code: "ERROR",
      message: error
    } : error instanceof Error ? {
      code: "ERROR",
      message: error.message
    } : error : void 0;
    if (errorObj) {
      return JSON.stringify({
        error: errorObj,
        result: result || ""
      });
    }
    if (result === void 0) {
      return "";
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  static decodeResult(result) {
    if (!result) {
      return {
        result: ""
      };
    }
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object") {
        if ("error" in parsed) {
          return {
            error: parsed.error,
            result: parsed.result || ""
          };
        }
        return {
          result: JSON.stringify(parsed)
        };
      }
      return {
        result
      };
    } catch (e) {
      return {
        result
      };
    }
  }
  hasError() {
    try {
      const { error } = ResultMessage.decodeResult(this.result);
      return !!error;
    } catch {
      return false;
    }
  }
  getError() {
    try {
      const { error } = ResultMessage.decodeResult(this.result);
      return error;
    } catch {
      return void 0;
    }
  }
};
__name(ResultMessage, "ResultMessage");
var AgentStateMessage = class extends Message {
  type = "AgentStateMessage";
  threadId;
  agentName;
  nodeName;
  runId;
  active;
  role;
  state;
  running;
};
__name(AgentStateMessage, "AgentStateMessage");
var ImageMessage = class extends Message {
  type = "ImageMessage";
  format;
  bytes;
  role;
  parentMessageId;
};
__name(ImageMessage, "ImageMessage");

export {
  Message,
  TextMessage,
  ActionExecutionMessage,
  ResultMessage,
  AgentStateMessage,
  ImageMessage
};
//# sourceMappingURL=chunk-SHBDMA63.mjs.map