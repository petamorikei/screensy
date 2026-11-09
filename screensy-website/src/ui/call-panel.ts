import { getElement } from "../dom.ts";

export interface CallMemberView {
  name: string;
  muted: boolean;
  camera: boolean;
  speaking: boolean;
}

/**
 * Which way to go when the shared sound would carry the call back: keep hearing the call without the shared sound, or
 * share the sound and mute the call on this page
 */
export type EchoChoice = "call" | "screen";

/**
 * The call: the buttons in the toolbar, the list of the participants in the call (#call-bar) and the choice about the
 * shared sound (#echo-choice). A simple first version.
 */
export class CallPanel {
  /**
   * Must call getUserMedia synchronously, while the click still counts as a user activation
   */
  public onjoin: (() => void) | null = null;
  public onleave: (() => void) | null = null;
  public onmute: ((muted: boolean) => void) | null = null;
  /**
   * Must call getUserMedia synchronously when it turns the camera on, like onjoin
   */
  public oncamera: ((on: boolean) => void) | null = null;
  public onechochoice: ((choice: EchoChoice) => void) | null = null;

  private readonly joinButton: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly cameraButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly members: HTMLUListElement;
  private readonly echoChoice: HTMLElement;
  private readonly mutedText: string;
  private readonly cameraText: string;
  private readonly muteText: string;
  private readonly unmuteText: string;
  private readonly cameraOnText: string;
  private readonly cameraOffText: string;
  private muted = false;
  private camera = false;

  constructor() {
    this.joinButton = getElement("call-join-button", HTMLButtonElement);
    this.muteButton = getElement("call-mute-button", HTMLButtonElement);
    this.cameraButton = getElement("call-camera-button", HTMLButtonElement);
    this.leaveButton = getElement("call-leave-button", HTMLButtonElement);
    this.bar = getElement("call-bar", HTMLElement);
    this.members = getElement("call-members", HTMLUListElement);
    this.echoChoice = getElement("echo-choice", HTMLElement);
    this.mutedText = getElement("text-call-muted", HTMLElement).textContent.trim();
    this.cameraText = getElement("text-call-camera", HTMLElement).textContent.trim();
    this.muteText = getElement("text-mute-microphone", HTMLElement).textContent.trim();
    this.unmuteText = getElement("text-unmute-microphone", HTMLElement).textContent.trim();
    this.cameraOnText = getElement("text-camera-on", HTMLElement).textContent.trim();
    this.cameraOffText = getElement("text-camera-off", HTMLElement).textContent.trim();

    this.joinButton.addEventListener("click", () => this.onjoin?.());
    this.leaveButton.addEventListener("click", () => this.onleave?.());
    this.muteButton.addEventListener("click", () => this.onmute?.(!this.muted));
    this.cameraButton.addEventListener("click", () => this.oncamera?.(!this.camera));
    getElement("echo-choice-call", HTMLButtonElement).addEventListener("click", () => this.onechochoice?.("call"));
    getElement("echo-choice-screen", HTMLButtonElement).addEventListener("click", () => this.onechochoice?.("screen"));
  }

  show(options: {
    /**
     * Connected to the room
     */
    ready: boolean;
    /**
     * The browser can capture a microphone
     */
    supported: boolean;
    /**
     * This client is in the call
     */
    joined: boolean;
    /**
     * Asking for the microphone to join the call
     */
    joining: boolean;
    muted: boolean;
    /**
     * The own camera is on, or being turned on
     */
    camera: boolean;
    /**
     * Asking for the camera, or waiting for the room to accept it
     */
    cameraBusy: boolean;
    members: CallMemberView[];
  }): void {
    this.muted = options.muted;
    this.camera = options.camera;
    this.joinButton.classList.toggle("hidden", !options.ready || !options.supported || options.joined);
    this.joinButton.disabled = options.joining;
    this.muteButton.classList.toggle("hidden", !options.joined);
    this.cameraButton.classList.toggle("hidden", !options.joined);
    this.leaveButton.classList.toggle("hidden", !options.joined);
    this.muteButton.textContent = options.muted ? this.unmuteText : this.muteText;
    this.muteButton.setAttribute("aria-pressed", options.muted.toString());
    this.cameraButton.textContent = options.camera ? this.cameraOffText : this.cameraOnText;
    this.cameraButton.setAttribute("aria-pressed", options.camera.toString());
    this.cameraButton.disabled = options.cameraBusy;

    this.bar.classList.toggle("hidden", options.members.length === 0);
    this.members.replaceChildren(...options.members.map((member) => this.memberItem(member)));
  }

  /**
   * Shows the choice about the shared sound until one is made, or hides it
   */
  showEchoChoice(visible: boolean): void {
    this.echoChoice.classList.toggle("hidden", !visible);
  }

  private memberItem(member: CallMemberView): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "call-member";
    // Names come from other people: text only
    item.textContent = member.name;
    item.toggleAttribute("data-muted", member.muted);
    item.toggleAttribute("data-speaking", member.speaking);

    const mark = (text: string, label: string) => {
      const element = document.createElement("span");
      element.className = "call-mark";
      element.textContent = text;
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", label);
      item.append(element);
    };

    if (member.camera) {
      mark("📷", this.cameraText);
    }

    if (member.muted) {
      mark("🔇", this.mutedText);
    }

    return item;
  }
}
