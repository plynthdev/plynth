// Downloads db-ip.com's free "IP to Country Lite" database (MMDB, CC BY 4.0, no account, updated monthly)
// to ELIGIBILITY_IP_DB (default data/dbip-country-lite.mmdb). Run monthly, e.g. from cron:
//   bun apps/eligibility/scripts/download-dbip.ts
// Falls back to last month's file early in a month, before the new one is published.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { MmdbCountry } from "../src/ipcountry";

const out = process.env.ELIGIBILITY_IP_DB || "data/dbip-country-lite.mmdb";
const months = [0, 1].map((back) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
});

for (const m of months) {
  const url = `https://download.db-ip.com/free/dbip-country-lite-${m}.mmdb.gz`;
  const r = await fetch(url);
  if (!r.ok) {
    console.log(`${url}: HTTP ${r.status}`);
    continue;
  }
  const buf = gunzipSync(Buffer.from(await r.arrayBuffer()));
  const db = new MmdbCountry(buf); // throws if the file is not a valid MMDB
  if (db.country("8.8.8.8") === null) throw new Error("downloaded database cannot resolve 8.8.8.8");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, buf);
  renameSync(`${out}.tmp`, out);
  console.log(`saved ${out} (${db.databaseType}, built ${db.buildEpoch.toISOString()}, ${buf.length} bytes)`);
  process.exit(0);
}
throw new Error("no db-ip country lite file found for this or last month");
