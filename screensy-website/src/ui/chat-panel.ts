import { getElement } from "../dom.ts";

/**
 * A message as the chat panel shows it
 */
export interface ChatEntryView {
  name: string;
  /**
   * The time on the author's clock, in milliseconds since the epoch
   */
  sentAt: number;
  text: string;
  self: boolean;
}

/**
 * Whether the scroll position is at the end of the log, give or take a few pixels
 */
const AT_END_PX = 20;

/**
 * The chat (#chat): a panel beside the stage that stays open while the screens play, opened by #chat-button, which
 * shows the number of unread messages
 */
export class ChatPanel {
  /**
   * Sends the trimmed text. Returns whether it was sent, which clears the input.
   */
  public onsend: ((text: string) => boolean) | null = null;

  private readonly button: HTMLButtonElement;
  private readonly unread: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly reach: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly reachText: string;
  private readonly aloneText: string;
  private readonly timeFormat: Intl.DateTimeFormat;
  private unreadCount = 0;

  constructor() {
    this.button = getElement("chat-button", HTMLButtonElement);
    this.unread = getElement("chat-unread", HTMLElement);
    this.panel = getElement("chat", HTMLElement);
    this.reach = getElement("chat-reach", HTMLElement);
    this.log = getElement("chat-log", HTMLElement);
    this.input = getElement("chat-input", HTMLTextAreaElement);
    this.sendButton = getElement("chat-send", HTMLButtonElement);
    this.reachText = getElement("text-chat-reach", HTMLElement).textContent.trim();
    this.aloneText = getElement("text-chat-alone", HTMLElement).textContent.trim();
    this.timeFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

    this.button.addEventListener("click", () => this.setOpen(!this.isOpen));
    getElement("chat-close", HTMLButtonElement).addEventListener("click", () => this.setOpen(false));

    getElement("chat-form", HTMLFormElement).addEventListener("submit", (event: SubmitEvent) => {
      event.preventDefault();
      this.submit();
    });

    // Enter sends and Shift+Enter adds a line, except while an input method composes text: its Enter confirms the
    // conversion. Safari reports the confirming Enter as keyCode 229 after the composition has ended.
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        this.submit();
      }
    });
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains("hidden");
  }

  /**
   * Shows the messages in order. The log follows new messages if it was scrolled to the end.
   */
  showMessages(entries: ChatEntryView[]): void {
    const atEnd = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < AT_END_PX;

    // Names and texts come from other people, so they are only ever set as text
    const items = entries.map((entry) => {
      const item = document.createElement("li");
      item.className = "chat-message";
      item.toggleAttribute("data-self", entry.self);

      const meta = document.createElement("div");
      meta.className = "chat-meta";

      const name = document.createElement("span");
      name.className = "chat-name";
      name.textContent = entry.name;

      const time = document.createElement("time");
      time.className = "chat-time";
      const date = new Date(entry.sentAt);

      if (!Number.isNaN(date.getTime())) {
        time.dateTime = date.toISOString();
        time.textContent = this.timeFormat.format(date);
      }

      meta.append(name, time);

      const text = document.createElement("p");
      text.className = "chat-text";
      text.textContent = entry.text;

      item.append(meta, text);
      return item;
    });

    this.log.replaceChildren(...items);

    if (atEnd) {
      this.scrollToEnd();
    }
  }

  /**
   * Counts a new message from someone else, unless the panel is open
   */
  addUnread(): void {
    if (!this.isOpen) {
      this.unreadCount++;
      this.showUnread();
    }
  }

  /**
   * Shows how many of the other connected participants the chat reaches
   */
  setReach(open: number, total: number): void {
    this.reach.textContent =
      total === 0
        ? this.aloneText
        : this.reachText.replace("{open}", open.toString()).replace("{total}", total.toString());
    this.reach.classList.toggle("chat-reach-partial", open < total);
  }

  /**
   * Allows sending while the chat knows its room
   */
  setEnabled(enabled: boolean): void {
    this.input.disabled = !enabled;
    this.sendButton.disabled = !enabled;
  }

  private setOpen(open: boolean): void {
    this.panel.classList.toggle("hidden", !open);
    this.button.setAttribute("aria-expanded", open.toString());

    if (open) {
      this.unreadCount = 0;
      this.showUnread();
      this.scrollToEnd();
      this.input.focus();
    }
  }

  private showUnread(): void {
    this.unread.textContent = this.unreadCount.toString();
    this.unread.classList.toggle("hidden", this.unreadCount === 0);
  }

  private scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  private submit(): void {
    const text = this.input.value.trim();

    if (text !== "" && this.onsend?.(text) === true) {
      this.input.value = "";
    }
  }
}
