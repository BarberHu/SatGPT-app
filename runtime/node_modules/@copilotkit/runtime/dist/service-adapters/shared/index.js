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

// src/service-adapters/shared/index.ts
var shared_exports = {};
__export(shared_exports, {
  convertServiceAdapterError: () => convertServiceAdapterError
});
module.exports = __toCommonJS(shared_exports);

// src/service-adapters/shared/error-utils.ts
var import_shared = require("@copilotkit/shared");
function convertServiceAdapterError(error, adapterName) {
  var _a, _b, _c;
  const errorName = ((_a = error == null ? void 0 : error.constructor) == null ? void 0 : _a.name) || error.name;
  const errorMessage = (error == null ? void 0 : error.message) || String(error);
  const statusCode = error.status || error.statusCode || ((_b = error.response) == null ? void 0 : _b.status);
  const responseData = error.error || ((_c = error.response) == null ? void 0 : _c.data) || error.data;
  const structuredError = new import_shared.CopilotKitLowLevelError({
    error: error instanceof Error ? error : new Error(errorMessage),
    url: `${adapterName} service adapter`,
    message: `${adapterName} API error: ${errorMessage}`
  });
  if (statusCode) {
    structuredError.statusCode = statusCode;
  }
  if (responseData) {
    structuredError.responseData = responseData;
  }
  if (errorName) {
    structuredError.originalErrorType = errorName;
  }
  let newCode;
  if (statusCode === 401) {
    newCode = import_shared.CopilotKitErrorCode.AUTHENTICATION_ERROR;
  } else if (statusCode >= 400 && statusCode < 500) {
    newCode = import_shared.CopilotKitErrorCode.CONFIGURATION_ERROR;
  } else if (statusCode >= 500) {
    newCode = import_shared.CopilotKitErrorCode.NETWORK_ERROR;
  } else if (statusCode) {
    newCode = import_shared.CopilotKitErrorCode.CONFIGURATION_ERROR;
  } else {
    newCode = import_shared.CopilotKitErrorCode.NETWORK_ERROR;
  }
  structuredError.code = newCode;
  if (structuredError.extensions) {
    structuredError.extensions.code = newCode;
  }
  return structuredError;
}
__name(convertServiceAdapterError, "convertServiceAdapterError");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  convertServiceAdapterError
});
//# sourceMappingURL=index.js.map