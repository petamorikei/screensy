import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { RoomController } from "./room-controller.ts";
import { generateRoomName } from "./room-name.ts";
import { store, unsupportedAtom } from "./state/atoms.ts";
import type { UnsupportedId } from "./state/views.ts";

/**
 * What the browser lacks of what screensy needs, or null
 */
const missingSupport = (): UnsupportedId | null => {
  if (!("WebSocket" in window)) {
    return "websocket";
  }

  if (!("mediaDevices" in navigator)) {
    return "mediastream";
  }

  if (!("RTCPeerConnection" in window)) {
    return "webrtc";
  }

  return null;
};

const main = (): void => {
  let isCreator = false;

  if (window.location.hash === "" || window.location.hash === "#") {
    // Put the user in a new room. replaceState does not fire "hashchange", so the page does not reload.
    history.replaceState(null, "", `#${generateRoomName()}`);
    isCreator = true;
  }

  // If the user manually changes the hash, force a reload
  window.onhashchange = () => {
    location.reload();
  };

  const missing = missingSupport();
  const controller = missing == null ? new RoomController(window.location.hash.substring(1), isCreator) : null;

  if (missing != null) {
    store.set(unsupportedAtom, missing);
  }

  const root = document.getElementById("root");

  if (root == null) {
    throw new Error("The page has no #root.");
  }

  createRoot(root).render(
    <StrictMode>
      <App controller={controller} />
    </StrictMode>,
  );

  if (controller != null) {
    window.addEventListener("beforeunload", () => controller.close());
    controller.start();
  }
};

window.addEventListener("DOMContentLoaded", main);
