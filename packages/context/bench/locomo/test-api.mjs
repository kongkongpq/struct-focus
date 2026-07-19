const h = "***REMOVED***.***REMOVED***";
console.log("Starting...");
fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + h },
  body: JSON.stringify({ model: "glm-4-flash", messages: [{ role: "user", content: "hello" }], max_tokens: 5 }),
}).then(r => { console.log("Status:", r.status); return r.json(); })
  .then(d => console.log("Body:", JSON.stringify(d).slice(0, 500)))
  .catch(e => console.error("Error:", e));

setTimeout(() => console.log("Done waiting."), 15000);
