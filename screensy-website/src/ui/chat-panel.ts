import { getElement } from "../dom.ts";

/**
 * A file of a message as the chat panel shows it: what this page can do with it
 */
export interface ChatFileView {
  id: string;
  name: string;
  /**
   * The size, formatted
   */
  size: string;
  /**
   * "own": this page shares it. "ended": this page shared it before a reload, which forgot it. "stopped": nobody here
   * has it, but its sender is here. "unreachable": nobody here has it. "receiving" has the progress, from 0 to 1, and
   * "done" the URL to save it from.
   */
  status: "own" | "ended" | "stopped" | "unreachable" | "idle" | "receiving" | "done" | "failed";
  progress: number;
  url: string | null;
}

/**
 * A message as the chat panel shows it
 */
export interface ChatEntryView {
  name: string;
  /**
   * The time on the author's clock, in milliseconds since the epoch
   */
  sentAt: number;
  /**
   * Empty for a file without a text
   */
  text: string;
  self: boolean;
  file: ChatFileView | null;
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
  /**
   * Shares a file chosen with the attach button. Returns whether it was sent.
   */
  public onattach: ((file: File) => boolean) | null = null;
  public ondownload: ((fileId: string) => void) | null = null;
  public oncanceldownload: ((fileId: string) => void) | null = null;
  /**
   * The file chosen again for an own message whose sharing ended
   */
  public onresume: ((fileId: string, file: File) => void) | null = null;

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
  private readonly attachButton: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private readonly resumeInput: HTMLInputElement;
  private readonly fileTexts: Record<
    "download" | "cancel" | "save" | "retry" | "unreachable" | "stopped" | "ended" | "resume" | "receiving",
    string
  >;

  /**
   * The file of the own message that "Choose again" is for
   */
  private resumeFileId: string | null = null;
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

    this.attachButton = getElement("chat-attach", HTMLButtonElement);
    this.fileInput = getElement("chat-file", HTMLInputElement);
    this.resumeInput = getElement("chat-resume-file", HTMLInputElement);
    const text = (id: string) => getElement(id, HTMLElement).textContent.trim();
    this.fileTexts = {
      download: text("text-file-download"),
      cancel: text("text-file-cancel"),
      save: text("text-file-save"),
      retry: text("text-file-retry"),
      unreachable: text("text-file-unreachable"),
      stopped: text("text-file-stopped"),
      ended: text("text-file-ended"),
      resume: text("text-file-resume"),
      receiving: text("text-file-receiving"),
    };

    this.attachButton.addEventListener("click", () => this.fileInput.click());
    this.fileInput.addEventListener("change", () => {
      for (const file of this.fileInput.files ?? []) {
        this.onattach?.(file);
      }

      this.fileInput.value = "";
    });

    this.resumeInput.addEventListener("change", () => {
      const file = this.resumeInput.files?.[0];

      if (file != null && this.resumeFileId != null) {
        this.onresume?.(this.resumeFileId, file);
      }

      this.resumeInput.value = "";
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

      item.append(meta);

      if (entry.file != null) {
        item.append(this.fileRow(entry.file));
      }

      if (entry.text !== "") {
        const text = document.createElement("p");
        text.className = "chat-text";
        text.textContent = entry.text;
        item.append(text);
      }

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
    this.attachButton.disabled = !enabled;
  }

  /**
   * The name and size of a file, and what to do with it. The name comes from someone else: text only.
   */
  private fileRow(file: ChatFileView): HTMLElement {
    const row = document.createElement("div");
    row.className = "chat-file";
    row.dataset.fileId = file.id;
    row.dataset.status = file.status;

    const label = document.createElement("span");
    label.className = "chat-file-name";
    label.textContent = `📎 ${file.name} (${file.size})`;
    row.append(label);

    const button = (text: string, onclick: () => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.addEventListener("click", onclick);
      row.append(element);
    };

    const note = (text: string) => {
      const element = document.createElement("span");
      element.className = "chat-file-note";
      element.textContent = text;
      row.append(element);
    };

    switch (file.status) {
      case "own":
        break;
      case "ended":
        note(this.fileTexts.ended);
        button(this.fileTexts.resume, () => {
          this.resumeFileId = file.id;
          this.resumeInput.click();
        });
        break;
      case "stopped":
        note(this.fileTexts.stopped);
        break;
      case "unreachable":
        note(this.fileTexts.unreachable);
        break;
      case "idle":
        button(this.fileTexts.download, () => this.ondownload?.(file.id));
        break;
      case "failed":
        button(this.fileTexts.retry, () => this.ondownload?.(file.id));
        break;
      case "receiving":
        note(this.fileTexts.receiving.replace("{percent}", Math.floor(file.progress * 100).toString()));
        button(this.fileTexts.cancel, () => this.oncanceldownload?.(file.id));
        break;
      case "done": {
        const link = document.createElement("a");
        link.href = file.url ?? "";
        link.download = file.name;
        link.textContent = this.fileTexts.save;
        row.append(link);
        break;
      }
    }

    return row;
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
