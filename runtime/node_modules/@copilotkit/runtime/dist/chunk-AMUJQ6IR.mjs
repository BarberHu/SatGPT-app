import {
  __name
} from "./chunk-FHD4JECV.mjs";

// src/service-adapters/shared/error-utils.ts
import { CopilotKitLowLevelError, CopilotKitErrorCode } from "@copilotkit/shared";
function convertServiceAdapterError(error, adapterName) {
  var _a, _b, _c;
  const errorName = ((_a = error == null ? void 0 : error.constructor) == null ? void 0 : _a.name) || error.name;
  const errorMessage = (error == null ? void 0 : error.message) || String(error);
  const statusCode = error.status || error.statusCode || ((_b = error.response) == null ? void 0 : _b.status);
  const responseData = error.error || ((_c = error.response) == null ? void 0 : _c.data) || error.data;
  const structuredError = new CopilotKitLowLevelError({
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
    newCode = CopilotKitErrorCode.AUTHENTICATION_ERROR;
  } else if (statusCode >= 400 && statusCode < 500) {
    newCode = CopilotKitErrorCode.CONFIGURATION_ERROR;
  } else if (statusCode >= 500) {
    newCode = CopilotKitErrorCode.NETWORK_ERROR;
  } else if (statusCode) {
    newCode = CopilotKitErrorCode.CONFIGURATION_ERROR;
  } else {
    newCode = CopilotKitErrorCode.NETWORK_ERROR;
  }
  structuredError.code = newCode;
  if (structuredError.extensions) {
    structuredError.extensions.code = newCode;
  }
  return structuredError;
}
__name(convertServiceAdapterError, "convertServiceAdapterError");

export {
  convertServiceAdapterError
};
//# sourceMappingURL=chunk-AMUJQ6IR.mjs.map