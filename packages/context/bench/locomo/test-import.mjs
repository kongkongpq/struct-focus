import { pathToFileURL } from "url";
const p = new URL("../../dist/index.js", import.meta.url).href;
import(p).then(m => console.log("exports:", Object.keys(m))).catch(e => console.error("ERR:", e.message));
