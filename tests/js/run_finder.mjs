import { readFileSync } from "fs";
import { findValueBets } from "../../docs/valuebet.js";
const ev = JSON.parse(readFileSync(process.argv[2]));
const [ref, dv, me] = [process.argv[3], process.argv[4], Number(process.argv[5])];
console.log(JSON.stringify(findValueBets(ev, { reference: ref, devigMethod: dv, minEdge: me }).map(b => [b.bookmaker, b.label, b.price, b.edge, b.stake])));
