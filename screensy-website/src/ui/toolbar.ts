import { BlurStrengthSchema } from "../blur.ts";
import { getElement } from "../dom.ts";

/**
 * The buttons at the top of the page, the blur strength slider and the number of viewers
 */
export class Toolbar {
  public onpresent: (() => void) | null = null;
  public onstop: (() => void) | null = null;
  /**
   * Must call getDisplayMedia synchronously, like the confirm handler of the dialog
   */
  public onswitch: (() => void) | null = null;
  public onhide: ((hidden: boolean) => void) | null = null;
  public onblur: ((blurred: boolean) => void) | null = null;
  public onblurstrength: ((strength: number) => void) | null = null;

  private readonly toolbar: HTMLElement;
  private readonly presentButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly showButton: HTMLButtonElement;
  private readonly blurButton: HTMLButtonElement;
  private readonly unblurButton: HTMLButtonElement;
  private readonly blurStrengthControl: HTMLElement;
  private readonly blurStrengthInput: HTMLInputElement;
  private readonly blurStrengthValue: HTMLOutputElement;
  private readonly viewerCount: HTMLElement;
  private readonly viewerCountValue: HTMLElement;

  constructor() {
    this.toolbar = getElement("toolbar", HTMLElement);
    this.presentButton = getElement("present-button", HTMLButtonElement);
    this.stopButton = getElement("stop-button", HTMLButtonElement);
    this.switchButton = getElement("switch-button", HTMLButtonElement);
    this.hideButton = getElement("hide-button", HTMLButtonElement);
    this.showButton = getElement("show-button", HTMLButtonElement);
    this.blurButton = getElement("blur-button", HTMLButtonElement);
    this.unblurButton = getElement("unblur-button", HTMLButtonElement);
    this.blurStrengthControl = getElement("blur-strength-control", HTMLElement);
    this.blurStrengthInput = getElement("blur-strength", HTMLInputElement);
    this.blurStrengthValue = getElement("blur-strength-value", HTMLOutputElement);
    this.viewerCount = getElement("viewer-count", HTMLElement);
    this.viewerCountValue = getElement("viewer-count-value", HTMLElement);

    this.presentButton.addEventListener("click", () => this.onpresent?.());
    this.stopButton.addEventListener("click", () => this.onstop?.());
    this.switchButton.addEventListener("click", () => this.onswitch?.());
    this.hideButton.addEventListener("click", () => this.onhide?.(true));
    this.showButton.addEventListener("click", () => this.onhide?.(false));
    this.blurButton.addEventListener("click", () => this.onblur?.(true));
    this.unblurButton.addEventListener("click", () => this.onblur?.(false));

    // Applied while the slider moves: the size of the sent video does not change with the strength
    this.blurStrengthInput.addEventListener("input", () => {
      const strength = BlurStrengthSchema.safeParse(Number(this.blurStrengthInput.value));

      if (strength.success) {
        this.blurStrengthValue.value = strength.data.toString();
        this.onblurstrength?.(strength.data);
      }
    });
  }

  setBlurStrength(strength: number): void {
    this.blurStrengthInput.value = strength.toString();
    this.blurStrengthValue.value = strength.toString();
  }

  show(options: {
    visible: boolean;
    canPresent: boolean;
    presenting: boolean;
    hidden: boolean;
    blurred: boolean;
    canBlur: boolean;
    /**
     * A switch or a blur change is in progress
     */
    busy: boolean;
    viewers: number;
  }): void {
    this.toolbar.classList.toggle("hidden", !options.visible);
    this.presentButton.classList.toggle("hidden", !options.canPresent);
    this.stopButton.classList.toggle("hidden", !options.presenting);
    this.switchButton.classList.toggle("hidden", !options.presenting);
    this.switchButton.disabled = options.busy;
    this.hideButton.classList.toggle("hidden", !options.presenting || options.hidden);
    this.showButton.classList.toggle("hidden", !options.presenting || !options.hidden);
    this.blurButton.classList.toggle("hidden", !options.presenting || !options.canBlur || options.blurred);
    this.unblurButton.classList.toggle("hidden", !options.presenting || !options.canBlur || !options.blurred);
    this.blurStrengthControl.classList.toggle("hidden", !options.presenting || !options.canBlur || !options.blurred);
    this.blurButton.disabled = options.busy;
    this.unblurButton.disabled = options.busy;
    this.viewerCount.classList.toggle("hidden", !options.presenting);
    this.viewerCountValue.textContent = options.viewers.toString();
  }
}
