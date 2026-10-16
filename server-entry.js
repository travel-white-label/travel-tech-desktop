// Entry point the desktop launcher runs instead of server.js directly. It is
// copied into the staged standalone folder by build.mjs.
//
// A child process on Windows does not die with its parent. If the Electron
// main process crashes (or is killed) before its before-quit handler runs, the
// server would linger with the database open and a port held. This wrapper
// watches the launcher's pid and exits as soon as it disappears; the launcher
// passes it as DESKTOP_PARENT_PID.
const parentPid = Number(process.env.DESKTOP_PARENT_PID);

if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0 = existence check only
    } catch {
      console.error("[desktop] launcher pid " + parentPid + " is gone, stopping the server");
      process.exit(0);
    }
  }, 3000).unref();
}

require("./server.js");
