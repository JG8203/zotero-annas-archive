import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { DEFAULT_BACKUP_MIRRORS_TEXT, DEFAULT_SCIDB_ENDPOINT } from "./mirrors";

export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window };
  } else {
    addon.data.prefs.window = _window;
  }
  updatePrefsUI();
  bindPrefEvents();
}

function getEndpointInput(): HTMLInputElement | null {
  return (
    (addon.data.prefs?.window.document.querySelector(
      `#zotero-prefpane-${config.addonRef}-endpoint`,
    ) as HTMLInputElement | null) ?? null
  );
}

function getBackupTextarea(): HTMLTextAreaElement | null {
  return (
    (addon.data.prefs?.window.document.querySelector(
      `#zotero-prefpane-${config.addonRef}-backupMirrors`,
    ) as HTMLTextAreaElement | null) ?? null
  );
}

async function updatePrefsUI() {
  if (!addon.data.prefs?.window) return;

  const endpointInput = getEndpointInput();
  if (endpointInput && !endpointInput.value) {
    endpointInput.value =
      (getPref("endpoint") as string) || DEFAULT_SCIDB_ENDPOINT;
  }

  const backupTextarea = getBackupTextarea();
  if (backupTextarea) {
    const stored = getPref("backupMirrors");
    backupTextarea.value =
      stored === undefined || stored === null
        ? DEFAULT_BACKUP_MIRRORS_TEXT
        : String(stored);
  }
}

function bindPrefEvents() {
  if (!addon.data.prefs?.window) return;

  const backupTextarea = getBackupTextarea();
  if (!backupTextarea) return;

  const persistBackups = () => {
    setPref("backupMirrors", backupTextarea.value);
    // Force rediscovery next time so order reflects new list cleanly
    setPref("mirrorsCache", "");
    ztoolkit.log("Updated backup mirrors pref");
  };

  backupTextarea.addEventListener("change", persistBackups);
  backupTextarea.addEventListener("blur", persistBackups);
}
