// electron-builder afterPack hook: drop Chromium runtime files TryDesk never loads, before the
// installer / portable are compressed. ~31 MB unpacked, ~12 MB off each download.
//
//   dxcompiler.dll        DirectX Shader Compiler for WebGPU/Dawn on D3D12 (TryDesk draws no WebGPU;
//                         Dawn falls back to d3dcompiler_47, which stays — ANGLE needs it)
//   vk_swiftshader.dll    SwiftShader: software Vulkan/WebGL. Software mode (VM / --no-gpu) uses
//   vk_swiftshader_icd.json  Chromium's software compositor, not SwiftShader; TryDesk uses no WebGL
//   vulkan-1.dll          Vulkan loader (ANGLE on Windows renders through D3D11)
//
// Capture (WGC / DXGI), video decode and the 2D canvas don't touch any of these. If a future feature
// needs WebGL or WebGPU, remove the file from this list.
const fs = require("fs");
const path = require("path");

const UNUSED = ["dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll"];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  let freed = 0;
  for (const name of UNUSED) {
    const f = path.join(context.appOutDir, name);
    try { freed += fs.statSync(f).size; fs.unlinkSync(f); } catch {}
  }
  console.log(`  • afterPack: removed unused Chromium files (${(freed / 1048576).toFixed(1)} MB)`);
};
