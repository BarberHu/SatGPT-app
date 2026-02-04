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

// src/graphql/types/base/index.ts
var base_exports = {};
__export(base_exports, {
  BaseMessageInput: () => BaseMessageInput
});
module.exports = __toCommonJS(base_exports);
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
var BaseMessageInput = class {
  id;
  createdAt;
};
__name(BaseMessageInput, "BaseMessageInput");
_ts_decorate([
  (0, import_type_graphql.Field)(() => String),
  _ts_metadata("design:type", String)
], BaseMessageInput.prototype, "id", void 0);
_ts_decorate([
  (0, import_type_graphql.Field)(() => Date),
  _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], BaseMessageInput.prototype, "createdAt", void 0);
BaseMessageInput = _ts_decorate([
  (0, import_type_graphql.InputType)()
], BaseMessageInput);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BaseMessageInput
});
//# sourceMappingURL=index.js.map