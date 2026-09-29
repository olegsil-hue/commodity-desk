const { studyWhileStopped } = require("../lib/sandbox-run");

async function loop() {
  try {
    const result = await studyWhileStopped();
    console.log(new Date().toISOString(), result.ready ? "ready" : "studying");
  } catch (error) {
    console.error("study", error.message);
  }
  setTimeout(loop, 60 * 60 * 1000);
}

loop();
