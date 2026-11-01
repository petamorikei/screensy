import { getElement, setNameSlots } from "../dom.ts";
import type { NoticeId, StatusId } from "./types.ts";
import { STATUS_IDS } from "./types.ts";

const NOTICE_TIMEOUT_MS = 10000;

/**
 * The notices at the bottom of the page, which hide by themselves, and the status of the whole page over the stage
 */
export class Notices {
  private readonly status: HTMLElement;
  private readonly noticeTimers = new Map<NoticeId, number>();

  constructor() {
    this.status = getElement("status", HTMLElement);

    for (const notice of document.querySelectorAll<HTMLElement>(".notice")) {
      notice.querySelector(".notice-close")?.addEventListener("click", () => this.hideNotice(notice.id as NoticeId));
    }
  }

  /**
   * Shows a status of the whole page over the stage, or none
   */
  showStatus(id: StatusId | null): void {
    for (const statusId of STATUS_IDS) {
      document.getElementById(statusId)?.classList.toggle("hidden", statusId !== id);
    }

    this.status.classList.toggle("hidden", id == null);
  }

  showNotice(id: NoticeId, name = ""): void {
    const element = document.getElementById(id);

    if (element == null) {
      return;
    }

    setNameSlots(element, name);
    element.classList.remove("hidden");

    window.clearTimeout(this.noticeTimers.get(id));
    this.noticeTimers.set(
      id,
      window.setTimeout(() => this.hideNotice(id), NOTICE_TIMEOUT_MS),
    );
  }

  hideNotice(id: NoticeId): void {
    window.clearTimeout(this.noticeTimers.get(id));
    this.noticeTimers.delete(id);
    document.getElementById(id)?.classList.add("hidden");
  }
}
