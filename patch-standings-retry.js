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
  `async function getStandingsPage(page){
  const maxAttempts=3;
  const retryDelayMs=2000;
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      return await fetchJSON(\`\${STANDINGS_URL}?page_standings=\${page}\`,20000,{label:\`standings page \${page}\`});
    }catch(error){
      lastError=error;
      console.error(\`Failed standings page \${page} attempt \${attempt}/\${maxAttempts}:\`,error.message);
      if(attempt<maxAttempts)await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
    }
  }
  throw lastError;
}`,
  `const STANDINGS_RETRY_DELAYS_MS = [60_000, 120_000, 180_000, 240_000, 300_000];

async function getStandingsPage(page){
  const maxAttempts=STANDINGS_RETRY_DELAYS_MS.length+1;
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      return await fetchJSON(\`\${STANDINGS_URL}?page_standings=\${page}\`,20000,{label:\`standings page \${page}\`});
    }catch(error){
      lastError=error;
      console.error(\`Failed standings page \${page} attempt \${attempt}/\${maxAttempts}:\`,error.message);
      const delay=STANDINGS_RETRY_DELAYS_MS[attempt-1];
      if(delay!==undefined){
        console.log(\`Waiting \${delay/1000}s before retrying standings page \${page}...\`);
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
  }
  throw lastError;
}`,
  "replace fast standings retry loop with lab-tested escalating backoff"
);

fs.writeFileSync(path, src);
console.log("server.js patched successfully (standings retry backoff).");
console.log(`Before: ${original.length} chars, After: ${src.length} chars`);
