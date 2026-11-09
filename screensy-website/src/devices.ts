import * as z from "zod";
import { CAMERA_CONSTRAINTS, MICROPHONE_CONSTRAINTS } from "./outgoing-call.ts";
import { getLocalStorage, readStorage, writeStorage } from "./storage.ts";

const DEVICES_STORAGE_KEY = "screensy.devices";
const MAX_DEVICE_ID_LENGTH = 256;

const DeviceIdSchema = z.string().max(MAX_DEVICE_ID_LENGTH);

/**
 * The devices chosen in the menu, by device ID. An empty ID is the browser's default.
 */
const DeviceChoiceSchema = z.object({
  microphone: DeviceIdSchema.catch(""),
  camera: DeviceIdSchema.catch(""),
  speaker: DeviceIdSchema.catch(""),
});

export type DeviceChoice = z.infer<typeof DeviceChoiceSchema>;
export type DeviceKind = keyof DeviceChoice;

/**
 * Anything stored that is not an object counts as an empty one, so that each field falls back to the default
 */
const StoredDeviceChoiceSchema = z.preprocess(
  (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}),
  DeviceChoiceSchema,
);

export const readDevices = (): DeviceChoice => {
  let stored: unknown = null;

  try {
    stored = JSON.parse(readStorage(getLocalStorage, DEVICES_STORAGE_KEY) ?? "null");
  } catch {
    // Not JSON: the defaults
  }

  return StoredDeviceChoiceSchema.parse(stored);
};

export const writeDevices = (choice: DeviceChoice): void => {
  writeStorage(getLocalStorage, DEVICES_STORAGE_KEY, JSON.stringify(choice));
};

/**
 * The chosen device is preferred, not required: if it is gone, the browser takes another one instead of failing.
 */
const withDevice = (constraints: MediaTrackConstraints, deviceId: string): MediaTrackConstraints =>
  deviceId === "" ? constraints : { ...constraints, deviceId: { ideal: deviceId } };

export const microphoneConstraints = (choice: DeviceChoice): MediaStreamConstraints => ({
  audio: withDevice(MICROPHONE_CONSTRAINTS, choice.microphone),
});

export const cameraConstraints = (choice: DeviceChoice): MediaStreamConstraints => ({
  video: withDevice(CAMERA_CONSTRAINTS, choice.camera),
});

/**
 * A device that the menu offers
 */
export interface DeviceOption {
  id: string;
  /**
   * Empty until the page may use the devices of that kind: the browser hides the names before
   */
  label: string;
}

/**
 * The microphones, cameras and speakers that the browser lists
 */
export const listDevices = async (): Promise<Record<DeviceKind, DeviceOption[]>> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const of = (kind: MediaDeviceKind): DeviceOption[] =>
    devices
      // Before a permission, the browser lists one device of each kind without an ID
      .filter((device) => device.kind === kind && device.deviceId !== "" && device.deviceId !== "default")
      .map((device) => ({ id: device.deviceId, label: device.label }));

  return { microphone: of("audioinput"), camera: of("videoinput"), speaker: of("audiooutput") };
};

/**
 * Whether media elements can play on a chosen speaker
 */
export const canChooseSpeaker = (): boolean => "setSinkId" in HTMLMediaElement.prototype;

/**
 * Plays a media element on the chosen speaker, where the browser can. A speaker that is gone leaves the element on
 * the previous one.
 */
export const applySpeaker = async (media: HTMLMediaElement, deviceId: string): Promise<void> => {
  if (!canChooseSpeaker() || media.sinkId === deviceId) {
    return;
  }

  try {
    await media.setSinkId(deviceId);
  } catch (error) {
    console.warn("Could not choose the speaker.", error);
  }
};
