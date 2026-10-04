#!/usr/bin/env bun
// policy-compiler compile <template.yaml> [--controller 0x..] [--network mainnet|testnet] [--json]
// policy-compiler diff <old.yaml> <new.yaml> [--controller 0x..]
import { compileFile, diff, summary, type CompileOptions } from "@/treasury/policy-compiler";

function opts(args: string[]): CompileOptions & { json: boolean; rest: string[] } {
  const o: CompileOptions & { json: boolean; rest: string[] } = { json: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--controller") o.controller = args[++i]!;
    else if (a === "--network") o.network = args[++i] as NonNullable<CompileOptions["network"]>;
    else if (a === "--json") o.json = true;
    else o.rest.push(a);
  }
  return o;
}

const [cmd, ...args] = Bun.argv.slice(2);
const o = opts(args);
const jsonOut = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

if (cmd === "compile" && o.rest.length === 1) {
  const c = compileFile(o.rest[0]!, o);
  console.log(o.json ? jsonOut(c) : summary(c));
} else if (cmd === "diff" && o.rest.length === 2) {
  console.log(diff(compileFile(o.rest[0]!, o), compileFile(o.rest[1]!, o)));
} else {
  console.error("usage: policy-compiler compile <template.yaml> [--controller 0x..] [--network n] [--json]\n" +
    "       policy-compiler diff <old.yaml> <new.yaml> [--controller 0x..]");
  process.exit(2);
}
