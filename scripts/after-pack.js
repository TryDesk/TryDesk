// electron-builder afterPack hook, run on the unpacked app before the installer / portable are compressed:
//
// 1. Drop Chromium runtime files TryDesk never loads (Windows). ~31 MB unpacked, ~12 MB off each download.
//
//   dxcompiler.dll        DirectX Shader Compiler for WebGPU/Dawn on D3D12 (TryDesk draws no WebGPU;
//                         Dawn falls back to d3dcompiler_47, which stays — ANGLE needs it)
//   vk_swiftshader.dll    SwiftShader: software Vulkan/WebGL. Software mode (VM / --no-gpu) uses
//   vk_swiftshader_icd.json  Chromium's software compositor, not SwiftShader; TryDesk uses no WebGL
//   vulkan-1.dll          Vulkan loader (ANGLE on Windows renders through D3D11)
//
// Capture (WGC / DXGI), video decode and the 2D canvas don't touch any of these. If a future feature
// needs WebGL or WebGPU, remove the file from this list.
//
// 2. Electron fuses (Windows + Linux). Another program running as the same user could otherwise start TryDesk as a
//    plain Node.js (ELECTRON_RUN_AS_NODE), pass NODE_OPTIONS, or attach the Node inspector before main.js gets to
//    refuse it — all ways to run code inside TryDesk and reach its file and input IPC. Not on macOS: flipping a
//    fuse rewrites the binary, and a Mac build made in WSL cannot re-sign it (Apple Silicon would refuse to start).
const fs = require("fs");
const path = require("path");

const UNUSED = ["dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll"];

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform === "win32") {
    let freed = 0;
    for (const name of UNUSED) {
      const f = path.join(context.appOutDir, name);
      try { freed += fs.statSync(f).size; fs.unlinkSync(f); } catch {}
    }
    console.log(`  • afterPack: removed unused Chromium files (${(freed / 1048576).toFixed(1)} MB)`);
  }
  if (platform === "win32" || platform === "linux") {
    const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
    const exe = platform === "win32"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
      : path.join(context.appOutDir, context.packager.executableName);
    await flipFuses(exe, {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
    console.log(`  • afterPack: Electron fuses set on ${path.basename(exe)} (no run-as-node, NODE_OPTIONS, inspector)`);
  }
};
