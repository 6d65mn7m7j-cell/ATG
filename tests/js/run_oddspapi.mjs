import { readFileSync } from "fs";
import { evaluateOddspapi } from "../../docs/valuebet.js";
const [meta, sample, method] = [JSON.parse(readFileSync(process.argv[2])), JSON.parse(readFileSync(process.argv[3])), process.argv[4]];
const res = evaluateOddspapi(sample.iddaa, sample.pinnacle, meta, { devigMethod: method });
console.log(JSON.stringify({ ...res, rows: res.rows.map((x) => [x.event_id, x.market_id, x.outcome_id, x.label, x.market_label, x.odds, x.fair_probability, x.edge]) }));
