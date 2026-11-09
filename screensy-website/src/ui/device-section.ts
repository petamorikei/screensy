import type { DeviceChoice, DeviceKind, DeviceOption } from "../devices.ts";
import { getElement } from "../dom.ts";

const KINDS: DeviceKind[] = ["microphone", "camera", "speaker"];

/**
 * The devices of the call in the menu (#menu-devices): one select per kind, with the browser's default first
 */
export class DeviceSection {
  public ondevicechange: ((kind: DeviceKind, deviceId: string) => void) | null = null;

  private readonly section: HTMLElement;
  private readonly selects: Record<DeviceKind, HTMLSelectElement>;
  private readonly speakerLabel: HTMLElement;
  private readonly defaultText: string;
  private readonly numberedText: string;

  constructor() {
    this.section = getElement("menu-devices", HTMLElement);
    this.speakerLabel = getElement("device-speaker-label", HTMLElement);
    this.defaultText = getElement("text-device-default", HTMLElement).textContent.trim();
    this.numberedText = getElement("text-device-numbered", HTMLElement).textContent.trim();
    this.selects = {
      microphone: getElement("device-microphone", HTMLSelectElement),
      camera: getElement("device-camera", HTMLSelectElement),
      speaker: getElement("device-speaker", HTMLSelectElement),
    };

    for (const kind of KINDS) {
      const select = this.selects[kind];
      select.addEventListener("change", () => this.ondevicechange?.(kind, select.value));
    }
  }

  /**
   * @param canChooseSpeaker Whether the browser can play on another speaker
   */
  show(visible: boolean, canChooseSpeaker: boolean): void {
    this.section.classList.toggle("hidden", !visible);
    this.speakerLabel.classList.toggle("hidden", !canChooseSpeaker);
    this.selects.speaker.classList.toggle("hidden", !canChooseSpeaker);
  }

  /**
   * Lists the devices. A chosen device that is gone shows as the default, but stays chosen for when it comes back.
   */
  showDevices(devices: Record<DeviceKind, DeviceOption[]>, choice: DeviceChoice): void {
    for (const kind of KINDS) {
      const select = this.selects[kind];
      // The kind's name, from the label of its select
      const kindName = select.labels?.[0]?.textContent.trim() ?? kind;
      const options = [{ id: "", label: this.defaultText }, ...devices[kind]].map((device, index) => {
        const option = document.createElement("option");
        option.value = device.id;
        // Device names come from the system: text only
        option.textContent =
          device.label !== ""
            ? device.label
            : this.numberedText.replace("{kind}", kindName).replace("{number}", index.toString());
        return option;
      });

      select.replaceChildren(...options);
      select.value = devices[kind].some((device) => device.id === choice[kind]) ? choice[kind] : "";
    }
  }
}
