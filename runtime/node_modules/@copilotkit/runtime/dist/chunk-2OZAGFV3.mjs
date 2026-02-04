import {
  __name
} from "./chunk-FHD4JECV.mjs";

// src/graphql/types/base/index.ts
import { Field, InputType } from "type-graphql";
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
  Field(() => String),
  _ts_metadata("design:type", String)
], BaseMessageInput.prototype, "id", void 0);
_ts_decorate([
  Field(() => Date),
  _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], BaseMessageInput.prototype, "createdAt", void 0);
BaseMessageInput = _ts_decorate([
  InputType()
], BaseMessageInput);

export {
  BaseMessageInput
};
//# sourceMappingURL=chunk-2OZAGFV3.mjs.map