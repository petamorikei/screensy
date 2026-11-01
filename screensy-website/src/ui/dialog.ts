import { getElement } from "../dom.ts";
import type { DialogMode } from "./types.ts";

/**
 * The dialog that starts or resumes presenting (#present-dialog)
 */
export class PresentDialog {
  /**
   * The name typed in the dialog, and the presenter chosen to take over in a full room, or null. Must call
   * getDisplayMedia synchronously, while the click still counts as a user activation.
   */
  public onconfirm: ((name: string, replace: string | null) => void) | null = null;
  public oncancel: (() => void) | null = null;

  private readonly dialog: HTMLDialogElement;
  private readonly nameInput: HTMLInputElement;

  constructor() {
    this.dialog = getElement("present-dialog", HTMLDialogElement);
    this.nameInput = getElement("present-name", HTMLInputElement);

    // The confirm handler must run synchronously in the submit event, so that getDisplayMedia still has the user
    // activation of the click
    getElement("present-form", HTMLFormElement).addEventListener("submit", (event: SubmitEvent) => {
      event.preventDefault();
      const name = this.nameInput.value.trim();
      const replace = this.dialog.querySelector<HTMLInputElement>('input[name="replace"]:checked')?.value ?? null;
      this.dialog.close();
      this.onconfirm?.(name, replace);
    });

    getElement("present-cancel", HTMLButtonElement).addEventListener("click", () => {
      this.dialog.close();
      this.oncancel?.();
    });

    this.dialog.addEventListener("cancel", (event: Event) => {
      event.preventDefault();
      this.dialog.close();
      this.oncancel?.();
    });
  }

  /**
   * Opens the dialog.
   *
   * @param mode "start" to start presenting, "resume" to resume after a reload
   * @param full In a full room, its limit and the presenters to choose from, one of whom is taken over; otherwise null
   * @param name The name to fill in
   */
  open(
    mode: DialogMode,
    full: { maxPresenters: number; presenters: { id: string; name: string }[] } | null,
    name: string,
  ): void {
    const replaceable = full?.presenters ?? null;

    for (const element of this.dialog.querySelectorAll<HTMLElement>("[data-mode]")) {
      element.classList.toggle("hidden", element.dataset.mode !== mode);
    }

    // Names come from other people, so they are only ever set as text
    const fieldset = getElement("present-replace", HTMLElement);
    const options = (replaceable ?? []).map((presenter) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "replace";
      input.value = presenter.id;
      input.required = true;
      input.checked = replaceable?.length === 1;
      const name = document.createElement("span");
      name.textContent = presenter.name;
      label.append(input, name);
      return label;
    });

    getElement("present-replace-options", HTMLElement).replaceChildren(...options);
    fieldset.classList.toggle("hidden", replaceable == null);

    for (const slot of fieldset.querySelectorAll(".max-slot")) {
      slot.textContent = full?.maxPresenters.toString() ?? "";
    }

    this.nameInput.value = name;

    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  close(): void {
    this.dialog.close();
  }
}
