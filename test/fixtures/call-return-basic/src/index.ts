import { importedText } from "./helper.js";

function echo(value: string) {
  return value;
}

echo("unused");
console.log(echo("observed"));

const saved = echo("saved");

importedText();
console.log(importedText());
