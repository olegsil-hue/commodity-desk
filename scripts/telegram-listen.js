const notify = require("../lib/notify");

async function loop() {
  try {
    await notify.pull();
  } catch (error) {
    console.error("telegram", error.message);
  }
  setTimeout(loop, 5000);
}

notify.commands().catch(() => {});
loop();
