import unusedDefault from "./unused-default.js";
import usedDefault from "./used-default.js";
import { unusedNamed, usedNamed } from "./named-lib.js";
import * as unusedNamespace from "./unused-namespace.js";
import * as usedNamespace from "./used-namespace.js";
import type { UnusedType, UsedType } from "./types.js";

const result = usedDefault() + usedNamed + usedNamespace.value;
const typed: UsedType = { value: result };

void typed;
