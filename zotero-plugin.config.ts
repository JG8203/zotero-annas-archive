import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const root = dirname(fileURLToPath(import.meta.url));
const rdpPort = Number(process.env.ZOTERO_RDP_PORT || 6100);

/** Ensure MCP Bridge XPI is present in the scaffold profile before Zotero starts. */
function ensureMcpBridgeInProfile(profilePath: string) {
  const cached = resolve(root, ".scaffold/mcp-bridge/mcp-rdp@zotero.org.xpi");
  const destDir = resolve(profilePath, "extensions");
  const dest = resolve(destDir, "mcp-rdp@zotero.org.xpi");
  if (!existsSync(cached)) return;
  mkdirSync(destDir, { recursive: true });
  copyFileSync(cached, dest);
}

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  server: {
    prefs: {
      // MCP Bridge for Zotero — must match ZOTERO_RDP_PORT in .env / Cursor MCP
      "extensions.mcp-rdp.enabled": true,
      "extensions.mcp-rdp.port": rdpPort,
    },
    hooks: {
      "serve:init": () => {
        const profilePath =
          process.env.ZOTERO_PLUGIN_PROFILE_PATH ||
          resolve(root, ".scaffold/profile");
        ensureMcpBridgeInProfile(profilePath);
      },
    },
  },
});
