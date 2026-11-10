import { createContext, useContext } from "react";
import type { RoomController } from "../room-controller.ts";

/**
 * The controller of the room, for the components to call for what the person does
 */
export const ControllerContext = createContext<RoomController | null>(null);

export const useController = (): RoomController => {
  const controller = useContext(ControllerContext);

  if (controller == null) {
    throw new Error("The room has no controller.");
  }

  return controller;
};
