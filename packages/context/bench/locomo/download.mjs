import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "locomo10.json");
const URL = "https://cdn.jsdelivr.net/gh/snap-research/locomo@main/data/locomo10.json";

async function main() {
  console.log(`Fetching ${URL}...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${res.status}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(OUT, Buffer.from(buf));
  console.log(`Saved ${buf.byteLength} bytes`);

  const raw = fs.readFileSync(OUT, "utf-8");
  const data = JSON.parse(raw);
  console.log(`Conversations: ${data.length}`);

  let totalChars = 0;
  let totalQA = 0;
  for (const conv of data) {
    totalQA += conv.qa?.length ?? 0;
    for (const [k, v] of Object.entries(conv.conversation)) {
      if (k.startsWith("session_") && !k.endsWith("_date_time") && Array.isArray(v)) {
        for (const turn of v) {
          if (turn?.text) totalChars += turn.text.length;
        }
      }
    }
  }
  console.log(`Total QA: ${totalQA}`);
  console.log(`Total dialog chars: ${totalChars} (~${Math.round(totalChars / 3.5)} tokens)`);

  // Print sample QA per category
  const c0 = data[0];
  const byCat = {};
  for (const q of c0.qa) {
    byCat[q.category] = byCat[q.category] || [];
    if (byCat[q.category].length < 2) byCat[q.category].push(q);
  }
  console.log("\nSample QA per category:");
  for (const [cat, qs] of Object.entries(byCat)) {
    for (const q of qs) console.log(`  Cat ${cat}: ${q.question} → ${q.answer}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
