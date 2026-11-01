import { showPopup } from "./dom.ts";
import { RoomController } from "./room-controller.ts";
import { generateRoomName } from "./room-name.ts";

export const main = async (_event: Event) => {
  let isCreator = false;

  if (window.location.hash === "" || window.location.hash === "#") {
    // Put the user in a new room. replaceState does not fire "hashchange", so the page does not reload.
    history.replaceState(null, "", `#${generateRoomName()}`);
    isCreator = true;
  }

  // If the user manually changes the hash, force a reload
  window.onhashchange = (_event: Event) => {
    location.reload();
  };

  if (!("WebSocket" in window)) {
    showPopup("websockets-not-supported");
    return;
  }

  if (!("mediaDevices" in navigator)) {
    showPopup("mediastream-not-supported");
    return;
  }

  if (!("RTCPeerConnection" in window)) {
    showPopup("webrtc-not-supported");
    return;
  }

  const controller = new RoomController(window.location.hash.substring(1), isCreator);
  window.addEventListener("beforeunload", () => controller.close());
  controller.start();
};

window.addEventListener("DOMContentLoaded", main);
