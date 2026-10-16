// electron-builder afterPack hook. `extraResources` silently drops every
// `node_modules` directory it meets, which would strip the standalone server's
// traced dependencies (including `next` itself), so the server is copied into
// the packed app here, verbatim (pnpm's relative symlinks included), before
// the targets wrap appOutDir and before macOS signing.
const fs = require("fs");
const path = require("path");

module.exports = async function afterPack({ appOutDir, packager }) {
  const resources =
    packager.platform.name === "mac"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const target = path.join(resources, "standalone");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, "stage", "standalone"), target, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const nextPkg = path.join(target, "node_modules", "next", "package.json");
  if (!fs.existsSync(nextPkg)) throw new Error(`afterPack: ${nextPkg} missing after copy`);
  console.log(`  • afterPack       copied standalone server → ${target}`);
};
