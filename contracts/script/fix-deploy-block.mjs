// Replaces deployBlock in deployments/<network>.json with the first L2 block of the broadcast receipts.
// Needed on Arbitrum, where block.number inside the EVM is the L1 block number.
import { readFileSync, writeFileSync } from "node:fs";

const [network, chainId] = process.argv.slice(2);
if (!network || !chainId) {
  process.stderr.write("usage: node script/fix-deploy-block.mjs <network> <chainId>\n");
  process.exit(1);
}
const run = JSON.parse(readFileSync(`broadcast/Deploy.s.sol/${chainId}/run-latest.json`, "utf8"));
const first = Math.min(...run.receipts.map((r) => Number.parseInt(r.blockNumber, 16)));
const file = `deployments/${network}.json`;
const deployment = JSON.parse(readFileSync(file, "utf8"));
deployment.deployBlock = first;
writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
process.stdout.write(`${file}: deployBlock = ${first}\n`);
