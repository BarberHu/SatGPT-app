var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/utils/index.ts
var utils_exports = {};
__export(utils_exports, {
  GuardrailsValidationFailureResponse: () => GuardrailsValidationFailureResponse,
  MessageStreamInterruptedResponse: () => MessageStreamInterruptedResponse,
  UnknownErrorResponse: () => UnknownErrorResponse
});
module.exports = __toCommonJS(utils_exports);

// src/graphql/types/response-status.type.ts
var import_graphql_scalars = require("graphql-scalars");
var import_type_graphql = require("type-graphql");
function _ts_decorate(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function")
    r = Reflect.decorate(decorators, target, key, desc);
  else
    for (var i = decorators.length - 1; i >= 0; i--)
      if (d = decorators[i])
        r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
}
__name(_ts_decorate, "_ts_decorate");
function _ts_metadata(k, v) {
  if (typeof Reflect === "object" && typeof Reflect.metadata === "function")
    return Reflect.metadata(k, v);
}
__name(_ts_metadata, "_ts_metadata");
var ResponseStatusCode;
(function(ResponseStatusCode2) {
  ResponseStatusCode2["Pending"] = "pending";
  ResponseStatusCode2["Success"] = "success";
  ResponseStatusCode2["Failed"] = "failed";
})(ResponseStatusCode || (ResponseStatusCode = {}));
(0, import_type_graphql.registerEnumType)(ResponseStatusCode, {
  name: "ResponseStatusCode"
});
var BaseResponseStatus = /* @__PURE__ */ __name(class BaseResponseStatus2 {
  code;
}, "BaseResponseStatus");
_ts_decorate([
  (0, import_type_graphql.Field)(() => ResponseStatusCode),
  _ts_metadata("design:type", String)
], BaseResponseStatus.prototype, "code", void 0);
BaseResponseStatus = _ts_decorate([
  (0, import_type_graphql.InterfaceType)({
    resolveType(value) {
      if (value.code === "success") {
        return SuccessResponseStatus;
      } else if (value.code === "failed") {
        return FailedResponseStatus;
      } else if (value.code === "pending") {
        return PendingResponseStatus;
      }
      return void 0;
    }
  }),
  (0, import_type_graphql.ObjectType)()
], BaseResponseStatus);
var PendingResponseStatus = class extends BaseResponseStatus {
  code = "pending";
};
__name(PendingResponseStatus, "PendingResponseStatus");
PendingResponseStatus = _ts_decorate([
  (0, import_type_graphql.ObjectType)({
    implements: BaseResponseStatus
  })
], PendingResponseStatus);
var SuccessResponseStatus = class extends BaseResponseStatus {
  code = "success";
};
__name(SuccessResponseStatus, "SuccessResponseStatus");
SuccessResponseStatus = _ts_decorate([
  (0, import_type_graphql.ObjectType)({
    implements: BaseResponseStatus
  })
], SuccessResponseStatus);
var FailedResponseStatusReason;
(function(FailedResponseStatusReason2) {
  FailedResponseStatusReason2["GUARDRAILS_VALIDATION_FAILED"] = "GUARDRAILS_VALIDATION_FAILED";
  FailedResponseStatusReason2["MESSAGE_STREAM_INTERRUPTED"] = "MESSAGE_STREAM_INTERRUPTED";
  FailedResponseStatusReason2["UNKNOWN_ERROR"] = "UNKNOWN_ERROR";
})(FailedResponseStatusReason || (FailedResponseStatusReason = {}));
(0, import_type_graphql.registerEnumType)(FailedResponseStatusReason, {
  name: "FailedResponseStatusReason"
});
var FailedResponseStatus = class extends BaseResponseStatus {
  code = "failed";
  reason;
  details = null;
};
__name(FailedResponseStatus, "FailedResponseStatus");
_ts_decorate([
  (0, import_type_graphql.Field)(() => FailedResponseStatusReason),
  _ts_metadata("design:type", String)
], FailedResponseStatus.prototype, "reason", void 0);
_ts_decorate([
  (0, import_type_graphql.Field)(() => import_graphql_scalars.GraphQLJSON, {
    nullable: true
  }),
  _ts_metadata("design:type", typeof Record === "undefined" ? Object : Record)
], FailedResponseStatus.prototype, "details", void 0);
FailedResponseStatus = _ts_decorate([
  (0, import_type_graphql.ObjectType)({
    implements: BaseResponseStatus
  })
], FailedResponseStatus);
var ResponseStatusUnion = (0, import_type_graphql.createUnionType)({
  name: "ResponseStatus",
  types: () => [
    PendingResponseStatus,
    SuccessResponseStatus,
    FailedResponseStatus
  ]
});

// src/utils/failed-response-status-reasons.ts
var GuardrailsValidationFailureResponse = class extends FailedResponseStatus {
  reason = FailedResponseStatusReason.GUARDRAILS_VALIDATION_FAILED;
  constructor({ guardrailsReason }) {
    super();
    this.details = {
      guardrailsReason
    };
  }
};
__name(GuardrailsValidationFailureResponse, "GuardrailsValidationFailureResponse");
var MessageStreamInterruptedResponse = class extends FailedResponseStatus {
  reason = FailedResponseStatusReason.MESSAGE_STREAM_INTERRUPTED;
  constructor({ messageId }) {
    super();
    this.details = {
      messageId,
      description: "Check the message for mode details"
    };
  }
};
__name(MessageStreamInterruptedResponse, "MessageStreamInterruptedResponse");
var UnknownErrorResponse = class extends FailedResponseStatus {
  reason = FailedResponseStatusReason.UNKNOWN_ERROR;
  constructor({ description, originalError }) {
    super();
    this.details = {
      description,
      originalError
    };
  }
};
__name(UnknownErrorResponse, "UnknownErrorResponse");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GuardrailsValidationFailureResponse,
  MessageStreamInterruptedResponse,
  UnknownErrorResponse
});
//# sourceMappingURL=index.js.map