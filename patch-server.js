import fs from "fs";

const path = "./server.js";
let src = fs.readFileSync(path, "utf8");
const original = src;

function mustReplace(oldStr, newStr, label) {
  if (!src.includes(oldStr)) {
    throw new Error(`PATCH FAILED at step "${label}": expected text not found. No changes were saved.`);
  }
  src = src.replace(oldStr, newStr);
}

mustReplace(
  `    if(managers.length<band.sampleSize){
      console.log(
        \`GW \${gameweek} band \${band.name}: insufficient managers \${managers.length}/\${band.sampleSize}; lock attempt aborted and scheduler will retry later.\`
      );
      return false;
    }`,
  `    if(managers.length<band.sampleSize){
      console.log(
        \`GW \${gameweek} band \${band.name}: only found \${managers.length}/\${band.sampleSize} managers. Skipping this band (nothing saved for it); every other successful band will still be locked, and the calculator will fall back to the nearest successful band below it.\`
      );
      continue;
    }`,
  "stop aborting the whole lock attempt when one band is short"
);

fs.writeFileSync(path, src);
console.log("server.js patched successfully.");
console.log(`Before: ${original.length} chars, After: ${src.length} chars`);
