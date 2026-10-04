// Copies contract ABIs from Foundry artifacts into typed TypeScript modules for the SDK.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = join(root, "packages", "sdk", "src", "abis");
const contracts = [
  ["AaveExitMarket", "aaveExitMarketAbi"],
  ["MorphoVaultExitMarket", "morphoVaultExitMarketAbi"],
  ["ExeuntVault", "exeuntVaultAbi"],
  ["AaveCollateralRoute", "aaveCollateralRouteAbi"],
  ["PriceRouter", "priceRouterAbi"],
  ["TestToken", "testTokenAbi"],
];

mkdirSync(out, { recursive: true });
const index = [];
for (const [name, exportName] of contracts) {
  const artifact = JSON.parse(readFileSync(join(root, "contracts", "out", `${name}.sol`, `${name}.json`), "utf8"));
  const file = `${name}.ts`;
  writeFileSync(
    join(out, file),
    `// Generated from contracts/out by scripts/export-abis.mjs. Do not edit.\nexport const ${exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`,
  );
  index.push(`export { ${exportName} } from "./${name}.js";`);
}
index.push(`export * from "./external.js";`);
writeFileSync(join(out, "index.ts"), `${index.join("\n")}\n`);
console.log(`exported ${contracts.length} ABIs to ${out}`);
