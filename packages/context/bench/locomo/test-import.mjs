import { pathToFileURL } from "url";
const p = pathToFileURL("E:/Develop/SrcuctAgent/packages/context/dist/index.js").href;
import(p).then(m => console.log("exports:", Object.keys(m))).catch(e => console.error("ERR:", e.message));
